require('dotenv').config();
const fs = require('fs');

const EPISODE = process.argv[2] || 'EP4';
const EPISODE_FOLDER = `episodes/${EPISODE}`;

if (!fs.existsSync(EPISODE_FOLDER)) {
  fs.mkdirSync(EPISODE_FOLDER, { recursive: true });
}

const template = {
  episode: EPISODE,
  title: "YOUR EPISODE TITLE HERE",
  topic: "YOUR TOPIC HERE",
  voiceovers: [
    { id: "VO_Act1",  act: "Act 1 — The Promise",      text: "PASTE ACT 1 SCRIPT HERE" },
    { id: "VO_Act2",  act: "Act 2 — The Rise",          text: "PASTE ACT 2 SCRIPT HERE" },
    { id: "VO_Act3",  act: "Act 3 — The Deception",     text: "PASTE ACT 3 SCRIPT HERE" },
    { id: "VO_Act3B", act: "Act 3B — The Human Cost",   text: "PASTE ACT 3B SCRIPT HERE" },
    { id: "VO_Act4",  act: "Act 4 — The Fall",          text: "PASTE ACT 4 SCRIPT HERE" },
    { id: "VO_Act5",  act: "Act 5 — The Verdict",       text: "PASTE ACT 5 SCRIPT HERE" }
  ],
  images: []
};

const configPath = `${EPISODE_FOLDER}/config.json`;
fs.writeFileSync(configPath, JSON.stringify(template, null, 2));

console.log('');
console.log('✅ Episode config created: ' + configPath);
console.log('');
console.log('NEXT STEPS:');
console.log('1. Ask Claude to write the full script for your episode');
console.log('2. Paste each act into the voiceovers section of config.json');
console.log('3. Run: node pipeline-v2.cjs --vo-only');
console.log('4. Review the scene plan it prints');
console.log('5. Ask Claude to write exactly that many image prompts');
console.log('6. Paste image prompts into the images section of config.json');
console.log('7. Run: node pipeline-v2.cjs --images-only');
console.log('8. Run: node pipeline-v2.cjs --animate-only');
console.log('');