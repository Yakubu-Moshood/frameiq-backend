'use strict';

function shadowEnabled(env = process.env) {
  return String(env.EMPIRE_OMITTED_V3_SHADOW || '').trim().toLowerCase() === 'true';
}

async function runEoV3ShadowHook({
  env = process.env,
  testMode = String(env.TEST_MODE || '').trim().toLowerCase() === 'true',
  channelKey,
  episodeDbId,
  script,
  audioDir,
  episodeDir,
  pipelineDir,
  getChannelDna,
  loadShadow,
  logger = console,
} = {}) {
  if (!shadowEnabled(env)) return { status: 'skipped', reason: 'disabled' };
  if (testMode) return { status: 'skipped', reason: 'test_mode' };
  if (channelKey !== 'EmpireOmitted') return { status: 'skipped', reason: 'channel' };

  let channelDna;
  try {
    channelDna = await getChannelDna('EmpireOmitted');
    if (!channelDna) {
      logger.warn('[runner] Empire Omitted V3 shadow failed; continuing V2.');
      return { status: 'failed', reason: 'channel_dna' };
    }
  } catch (_) {
    logger.warn('[runner] Empire Omitted V3 shadow failed; continuing V2.');
    return { status: 'failed', reason: 'channel_dna' };
  }

  let shadow;
  try {
    shadow = loadShadow
      ? loadShadow(pipelineDir)
      : require(require('path').join(pipelineDir, 'eo-v3-shadow.cjs'));
  } catch (_) {
    logger.warn('[runner] Empire Omitted V3 shadow unavailable; continuing V2.');
    return { status: 'failed', reason: 'module_load' };
  }

  try {
    await shadow.runEmpireOmittedV3Shadow({
      script,
      audioDir,
      episodeDir,
      episodeId: episodeDbId,
      channel: 'EmpireOmitted',
      channelDna,
    });
    logger.log('[runner] Empire Omitted V3 shadow completed.');
    return { status: 'complete' };
  } catch (_) {
    logger.warn('[runner] Empire Omitted V3 shadow failed; continuing V2.');
    return { status: 'failed', reason: 'shadow' };
  }
}

module.exports = { runEoV3ShadowHook, shadowEnabled };
