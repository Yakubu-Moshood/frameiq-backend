'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const sampleActs = {
  act1: { label: 'THE HOOK', estimatedSeconds: 60, voScript: 'The cold open starts here.' },
  act2: { label: 'THE RISE', estimatedSeconds: 60, voScript: 'Act two.' },
  act3: { label: 'THE TRUTH', estimatedSeconds: 60, voScript: 'Act three.' },
  act3b: { label: 'THE COST', estimatedSeconds: 60, voScript: 'Act three B.' },
  act4: { label: 'THE FALL', estimatedSeconds: 60, voScript: 'Act four.' },
  act5: {
    label: 'THE VERDICT',
    estimatedSeconds: 60,
    voScript: 'Enron disappeared, but the warning it left behind still matters.',
  },
};

function claudeResponse({ includeEpisodeOpen }) {
  return JSON.stringify({
    title: 'Sample episode',
    topic: 'Sample topic',
    totalEstimatedSeconds: 360,
    ...(includeEpisodeOpen
      ? {
          episode_open: {
            setupSentenceA: 'In 2001, Enron reported 111 billion dollars in revenue.',
            setupSentenceB:
              'One year later, it was bankrupt — and the man who led it was facing criminal charges.',
          },
        }
      : {}),
    acts: structuredClone(sampleActs),
    youtubeDetails: {
      description: 'Description',
      tags: ['sample'],
      chapters: [{ time: '0:00', label: 'Intro' }],
    },
  });
}

let requestedChannel;
let capturedSystemPrompt;
let responseText;

class FakeAnthropic {
  constructor() {
    this.messages = {
      create: async request => {
        capturedSystemPrompt = request.system;
        return { content: [{ type: 'text', text: responseText }] };
      },
    };
  }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  if (request === '@anthropic-ai/sdk') return FakeAnthropic;
  if (request === './config-reader.cjs') {
    return {
      getChannelConfigByLabel: async channel => {
        requestedChannel = channel;
        return channel === 'EmpireOmitted'
          ? {
              label: 'Empire Omitted',
              blueprint_label: 'Documentary',
              target_length_minutes: 10,
              narration_style: 'dramatic-investigative',
              script_pacing: 'slow-build',
              episode_opening_enabled: true,
              sign_off_enabled: true,
            }
          : {
              label: 'Macro Decode',
              blueprint_label: 'Finance Explainer',
              target_length_minutes: 10,
              narration_style: 'calm-explainer',
              script_pacing: 'steady',
              episode_opening_enabled: false,
              sign_off_enabled: false,
            };
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const writer = require('../pipeline-updates/surface-script-writer.cjs');
Module._load = originalLoad;

test('Empire Omitted planner adds the fixed opening and sign-off outside Claude output', async () => {
  responseText = claudeResponse({ includeEpisodeOpen: true });
  const script = await writer.writeScript({
    topic: 'The rise and fall of Enron',
    channel: 'EmpireOmitted',
  });

  assert.equal(requestedChannel, 'EmpireOmitted');
  assert.match(capturedSystemPrompt, /WeWork/);
  assert.match(capturedSystemPrompt, /Theranos/);
  assert.doesNotMatch(
    writer.EPISODE_OPENING_INSTRUCTIONS,
    /This is Empire Omitted, bringing you the story they didn't want told\./
  );
  assert.equal(capturedSystemPrompt.includes(writer.FIXED_SIGN_OFF_LINE), false);
  assert.deepEqual(script.episode_open, {
    setupSentenceA: 'In 2001, Enron reported 111 billion dollars in revenue.',
    setupSentenceB:
      'One year later, it was bankrupt — and the man who led it was facing criminal charges.',
    fixedClosingLine: writer.FIXED_EPISODE_OPENING_LINE,
  });
  assert.equal(
    script.acts.act1.voScript,
    'In 2001, Enron reported 111 billion dollars in revenue.\n' +
      'One year later, it was bankrupt — and the man who led it was facing criminal charges.\n' +
      "This is Empire Omitted, bringing you the story they didn't want told.\n\n" +
      'The cold open starts here.'
  );
  assert.equal(
    writer.FIXED_SIGN_OFF_LINE,
    'This is Empire Omitted — where the empires you once admired are laid to rest, and the stories they buried get dug back up. If you found this worth watching, subscribing and sharing help keep these episodes coming. Which corporate scandal should we examine next? Let us know in the comments.'
  );
  assert.deepEqual(script.sign_off, { text: writer.FIXED_SIGN_OFF_LINE });
  assert.equal(
    script.acts.act5.voScript,
    'Enron disappeared, but the warning it left behind still matters.\n\n' +
      writer.FIXED_SIGN_OFF_LINE
  );
});

test('a channel without the DNA opt-in keeps its existing script unchanged', async () => {
  responseText = claudeResponse({ includeEpisodeOpen: false });
  const script = await writer.writeScript({
    topic: 'Why interest rates move markets',
    channel: 'MoneyExplained',
  });

  assert.equal(requestedChannel, 'MoneyExplained');
  assert.doesNotMatch(capturedSystemPrompt, /EPISODE OPEN — REQUIRED/);
  assert.equal(script.episode_open, undefined);
  assert.equal(script.sign_off, undefined);
  assert.equal(script.acts.act1.voScript, 'The cold open starts here.');
  assert.equal(
    script.acts.act5.voScript,
    'Enron disappeared, but the warning it left behind still matters.'
  );
});
