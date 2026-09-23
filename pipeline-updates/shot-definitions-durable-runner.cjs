'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Anthropic = require('@anthropic-ai/sdk');
const { generateShotDefinitions } = require('./surface-shot-definitions.cjs');
const { validateShotDefinitions } = require('./shot-definitions-validator.cjs');

const ACT_ORDER = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];
const MAX_TOTAL_ATTEMPTS = 7;
const MODEL = 'claude-opus-4-5';

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) { /* preserve original error */ }
    throw error;
  }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return null; }
}

function runIdNow() {
  return `phase22b-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function safeError(error, secret) {
  let message = String(error?.message || error || 'Unknown generation failure').slice(0, 1200);
  if (secret) message = message.split(secret).join('[redacted]');
  return message.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]');
}

/**
 * Run V3 enrichment with durable operational state around the generator's
 * own atomic per-act checkpoints and final deterministic validation.
 */
async function runDurableShotDefinitionGeneration({
  script, outputDir, channel = 'EmpireOmitted', editPlan, editPlanValidation,
  wordTimestamps, sourceManifest, client: injectedClient, createClient,
  maxTotalAttempts = MAX_TOTAL_ATTEMPTS, onHeartbeat,
}) {
  if (!outputDir) throw new Error('[shot-defs-durable] outputDir is required.');
  if (!Number.isInteger(maxTotalAttempts) || maxTotalAttempts < 1 || maxTotalAttempts > MAX_TOTAL_ATTEMPTS) {
    throw new Error('[shot-defs-durable] maxTotalAttempts must be between 1 and 7.');
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const paths = {
    lock: path.join(outputDir, '.generation.lock'),
    pid: path.join(outputDir, 'generation.pid'),
    status: path.join(outputDir, 'generation-status.json'),
    log: path.join(outputDir, 'generation.log'),
    checkpoint: path.join(outputDir, '.shot-definitions-checkpoint.json'),
    candidate: path.join(outputDir, 'shot-definitions.json'),
  };
  const runId = runIdNow();
  const startedAt = new Date().toISOString();
  const lockFd = fs.openSync(paths.lock, 'wx', 0o600);
  fs.writeFileSync(lockFd, `${JSON.stringify({ runId, pid: process.pid, startedAt })}\n`);
  fs.fsyncSync(lockFd);

  const checkpoint = () => readJson(paths.checkpoint) || { providerCalls: 0, acts: {}, spendReservedUsd: 0 };
  const completedActs = () => {
    const saved = checkpoint();
    return ACT_ORDER.filter(actKey => Array.isArray(saved.acts?.[actKey]?.shots));
  };
  const savedAtStart = checkpoint();
  const completeAtStart = completedActs();
  const firstMissingAct = ACT_ORDER.find(actKey => !completeAtStart.includes(actKey)) || null;
  const attemptsByAct = Object.fromEntries(ACT_ORDER.map(actKey => [actKey, 0]));
  if (firstMissingAct) {
    attemptsByAct[firstMissingAct] = Math.max(0, Number(savedAtStart.providerCalls || 0) - completeAtStart.length);
  }
  let currentAct = firstMissingAct;
  let terminalState = 'running';
  let active = true;
  let actualRequestsInThisRun = 0;
  const appendLog = (event, fields = {}) => fs.appendFileSync(paths.log, `${JSON.stringify({ at: new Date().toISOString(), runId, event, ...fields })}\n`, { encoding: 'utf8', flag: 'a' });
  const writeStatus = extra => {
    const latest = checkpoint();
    atomicWriteJson(paths.status, {
      runId, pid: process.pid, executionMethod: 'detached nohup server-side Node process',
      startedAt, updatedAt: new Date().toISOString(), currentAct,
      completedActs: completedActs(), attemptsByAct,
      totalAnthropicAttempts: Number(latest.providerCalls || 0),
      actualRequestsInThisRun, terminalState, ...(extra || {}),
    });
    if (typeof onHeartbeat === 'function') onHeartbeat(readJson(paths.status));
  };
  const heartbeat = setInterval(() => {
    if (!active) return;
    try { writeStatus(); } catch (error) { appendLog('heartbeat-write-failed', { error: safeError(error) }); }
  }, 2000);
  heartbeat.unref();
  const releaseLock = () => {
    try {
      const owner = readJson(paths.lock);
      if (owner?.runId === runId) fs.unlinkSync(paths.lock);
    } catch (_) { /* stale lock remains visible for operator inspection */ }
    try { fs.closeSync(lockFd); } catch (_) { /* already closed */ }
  };
  const finish = (state, extra = {}) => {
    active = false;
    terminalState = state;
    clearInterval(heartbeat);
    try { writeStatus(extra); } catch (error) { appendLog('terminal-status-write-failed', { error: safeError(error) }); }
    appendLog('terminal', { state, ...extra });
    releaseLock();
  };

  try {
    atomicWriteJson(paths.pid, { runId, pid: process.pid, startedAt });
    writeStatus();
    appendLog('run-start', { pid: process.pid, completedActs: completeAtStart, totalAnthropicAttempts: Number(savedAtStart.providerCalls || 0) });
    if (channel !== 'EmpireOmitted') throw new Error('Only EmpireOmitted is authorized for V3 generation.');
    if (fs.existsSync(paths.candidate)) throw new Error('A final candidate already exists; refusing to overwrite it.');

    let client = injectedClient || null;
    const getClient = () => {
      if (!client) client = typeof createClient === 'function' ? createClient() : new Anthropic({ maxRetries: 0 });
      return client;
    };
    const guardedClient = {
      messages: {
        create: async request => {
          const prompt = String(request.messages?.[0]?.content || '');
          const match = prompt.match(/Create production enrichment for (act1|act2|act3|act3b|act4|act5)\b/);
          if (!match) throw new Error('Unexpected model request shape was blocked.');
          currentAct = match[1];
          const attemptForAct = (attemptsByAct[currentAct] || 0) + 1;
          const savedCheckpoint = checkpoint();
          const totalAttempt = Number(savedCheckpoint.providerCalls || 0);
          const maxForAct = currentAct === 'act1' ? 2 : 1;
          if (totalAttempt > maxTotalAttempts || attemptForAct > maxForAct || request.model !== MODEL) {
            // The generator increments its checkpoint immediately before this
            // wrapper. Roll back a blocked dispatch so durable counts represent
            // provider calls, not supervisor refusals.
            const requestTokensEstimate = Math.ceil(Buffer.byteLength(`${request.system}\n${request.messages?.[0]?.content || ''}`, 'utf8') / 3);
            savedCheckpoint.providerCalls = Math.max(0, totalAttempt - 1);
            savedCheckpoint.spendReservedUsd = Math.max(0, Number(savedCheckpoint.spendReservedUsd || 0)
              - (requestTokensEstimate * 3 + request.max_tokens * 15) / 1_000_000);
            atomicWriteJson(paths.checkpoint, savedCheckpoint);
            throw new Error(`Authorized request limit blocked ${currentAct} before provider dispatch.`);
          }
          attemptsByAct[currentAct] = attemptForAct;
          actualRequestsInThisRun += 1;
          writeStatus();
          appendLog('anthropic-attempt-start', { act: currentAct, actAttempt: attemptForAct, totalAttempt, model: request.model });
          try {
            const response = await getClient().messages.create(request);
            appendLog('anthropic-attempt-response', {
              act: currentAct, actAttempt: attemptForAct, totalAttempt,
              inputTokens: response.usage?.input_tokens ?? null,
              outputTokens: response.usage?.output_tokens ?? null,
            });
            return response;
          } catch (error) {
            appendLog('anthropic-attempt-error', { act: currentAct, actAttempt: attemptForAct, totalAttempt, error: safeError(error, process.env.ANTHROPIC_API_KEY) });
            throw error;
          }
        },
      },
    };

    const shotDefs = await generateShotDefinitions({
      script, outputDir, channel, mode: 'v3', editPlan, editPlanValidation,
      wordTimestamps, sourceManifest, client: guardedClient,
    });
    const report = validateShotDefinitions({ plan: editPlan, shotDefs });
    if (report.status !== 'PASS') throw new Error(`Final shot-definition validation failed: ${report.errors[0].code} ${report.errors[0].path}`);
    if (Object.keys(shotDefs.acts || {}).length !== ACT_ORDER.length) throw new Error('Final candidate act count mismatch.');

    const candidateSha256 = crypto.createHash('sha256').update(fs.readFileSync(paths.candidate)).digest('hex');
    const saved = checkpoint();
    const usage = Object.values(saved.acts || {}).map(act => act.usage).filter(Boolean);
    const inputTokens = usage.reduce((sum, item) => sum + (item.inputTokens || 0), 0);
    const outputTokens = usage.reduce((sum, item) => sum + (item.outputTokens || 0), 0);
    const actualCostUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
    atomicWriteJson(path.join(outputDir, 'shot-definitions-sha256.json'), {
      algorithm: 'SHA-256', file: 'shot-definitions.json', sha256: candidateSha256,
      sourceEditPlanSha256: shotDefs.sourceEditPlanSha256,
    });
    finish('success', {
      candidateSha256, validationStatus: report.status, sequenceCount: editPlan.sequences.length,
      definitionCount: shotDefs.totalShots, attemptsByAct,
      totalAnthropicAttempts: Number(saved.providerCalls || 0), actualRequestsInThisRun,
      actualInputTokens: inputTokens, actualOutputTokens: outputTokens,
      actualCostUsd: Number(actualCostUsd.toFixed(6)), reservedMaximumUsd: saved.spendReservedUsd || 0,
    });
    return { runId, shotDefs, report, candidateSha256, actualCostUsd };
  } catch (error) {
    const saved = checkpoint();
    finish('failure', {
      failedAct: currentAct, error: safeError(error, process.env.ANTHROPIC_API_KEY),
      completedActs: completedActs(), attemptsByAct,
      totalAnthropicAttempts: Number(saved.providerCalls || 0), actualRequestsInThisRun,
      finalCandidateExists: fs.existsSync(paths.candidate), reservedMaximumUsd: saved.spendReservedUsd || 0,
    });
    throw error;
  }
}

function runFromCli(argv = process.argv.slice(2)) {
  const episodeDir = argv[0];
  const outputDir = argv[1];
  if (!episodeDir || !outputDir) throw new Error('Usage: node shot-definitions-durable-runner.cjs <episodeDir> <candidateDir>');
  const { loadValidatedV3Plan } = require('./shot-definitions-validator.cjs');
  const scriptPath = path.join(episodeDir, 'script.json');
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const context = loadValidatedV3Plan({ episodeDir });
  const hashFile = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const resolvedEpisodeDir = path.resolve(episodeDir);
  const sourceManifest = {
    sourceEpisodeDir: resolvedEpisodeDir,
    scriptPath: path.resolve(scriptPath), scriptSha256: hashFile(scriptPath),
    editPlanPath: path.join(resolvedEpisodeDir, 'edit-plan.json'), editPlanSha256: hashFile(path.join(resolvedEpisodeDir, 'edit-plan.json')),
    validationPath: path.join(resolvedEpisodeDir, 'edit-plan-validation.json'), validationSha256: hashFile(path.join(resolvedEpisodeDir, 'edit-plan-validation.json')),
  };
  const manifestPath = path.join(outputDir, 'candidate-source-manifest.json');
  const lockedManifest = readJson(manifestPath);
  if (!lockedManifest || JSON.stringify(lockedManifest) !== JSON.stringify(sourceManifest)) {
    throw new Error('[shot-defs-durable] Candidate source manifest does not match the locked current inputs.');
  }
  const checkpoint = readJson(path.join(outputDir, '.shot-definitions-checkpoint.json'));
  if (!checkpoint || !checkpoint.acts || Object.keys(checkpoint.acts).length !== 0 || checkpoint.providerCalls !== 1) {
    throw new Error('[shot-defs-durable] Retry preflight requires the retained one-attempt checkpoint with zero completed acts.');
  }
  if (!Number.isFinite(checkpoint.spendReservedUsd) || checkpoint.spendReservedUsd < 0 || checkpoint.spendReservedUsd >= 5) {
    throw new Error('[shot-defs-durable] The retained checkpoint has invalid or exhausted reserved spend under the authorized $5 ceiling.');
  }
  if (fs.existsSync(path.join(resolvedEpisodeDir, 'shot-definitions.json'))) {
    throw new Error('[shot-defs-durable] Root shot-definitions.json exists; refusing to generate.');
  }
  return runDurableShotDefinitionGeneration({ script, outputDir, channel: 'EmpireOmitted', sourceManifest, ...context });
}

if (require.main === module) {
  runFromCli().catch(error => { console.error('[shot-defs-durable] FATAL:', safeError(error, process.env.ANTHROPIC_API_KEY)); process.exitCode = 1; });
}

module.exports = { runDurableShotDefinitionGeneration, runFromCli, ACT_ORDER, MAX_TOTAL_ATTEMPTS };
