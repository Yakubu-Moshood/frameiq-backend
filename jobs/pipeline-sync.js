'use strict';

const fs = require('fs');
const path = require('path');

const SYNC_EXTENSIONS = new Set(['.cjs', '.json']);

function listSyncFiles(root, fsImpl = fs, relative = '') {
  const entries = fsImpl.readdirSync(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...listSyncFiles(root, fsImpl, childRelative));
    else if (entry.isFile() && SYNC_EXTENSIONS.has(path.extname(entry.name))) files.push(childRelative);
  }
  return files;
}

function syncPipelineDirectory({ sourceDir, targetDir, fsImpl = fs, backupDir }) {
  if (!sourceDir || !targetDir || !fsImpl.existsSync(sourceDir)) return [];
  const files = listSyncFiles(sourceDir, fsImpl);
  const changed = files.filter(relative => {
    const sourcePath = path.join(sourceDir, relative);
    const targetPath = path.join(targetDir, relative);
    return !fsImpl.existsSync(targetPath)
      || !fsImpl.readFileSync(sourcePath).equals(fsImpl.readFileSync(targetPath));
  });
  const replacements = changed.filter(relative => fsImpl.existsSync(path.join(targetDir, relative)));
  if (replacements.length && !backupDir) {
    const uniqueRunId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '-' + Math.random().toString(16).slice(2);
    backupDir = path.join(targetDir, '.sync-backup', uniqueRunId);
  }

  const copied = [];
  for (const relative of changed) {
    const sourcePath = path.join(sourceDir, relative);
    const targetPath = path.join(targetDir, relative);
    fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (fsImpl.existsSync(targetPath)) {
      const backupPath = path.join(backupDir, relative);
      fsImpl.mkdirSync(path.dirname(backupPath), { recursive: true });
      fsImpl.copyFileSync(targetPath, backupPath);
    }

    const temporaryPath = targetPath + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
    try {
      fsImpl.copyFileSync(sourcePath, temporaryPath);
      fsImpl.renameSync(temporaryPath, targetPath);
      copied.push(relative.split(path.sep).join('/'));
    } finally {
      if (fsImpl.existsSync(temporaryPath)) fsImpl.unlinkSync(temporaryPath);
    }
  }
  return copied;
}

module.exports = { syncPipelineDirectory };
