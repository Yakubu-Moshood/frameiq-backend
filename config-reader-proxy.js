/**
 * data/config-reader-proxy.js
 * Thin proxy so backend routes can access the pipeline config-reader
 * without hardcoding the path everywhere.
 *
 * On Railway, config-reader.cjs lives on the Volume at /data/pipeline/
 * This proxy loads it from there at runtime.
 */

const path = require('path');

const CONFIG_READER_PATH = process.env.CONFIG_READER_PATH
  || '/data/pipeline/config-reader.cjs';

let _reader = null;

function getReader() {
  if (_reader) return _reader;
  try {
    _reader = require(CONFIG_READER_PATH);
    return _reader;
  } catch (err) {
    throw new Error(
      '[config-reader-proxy] Could not load config-reader.cjs from ' +
      CONFIG_READER_PATH + ': ' + err.message
    );
  }
}

async function getChannelConfig(id) {
  return getReader().getChannelConfig(id);
}

async function getChannelConfigByLabel(label) {
  return getReader().getChannelConfigByLabel(label);
}

async function getAllChannelConfigs() {
  return getReader().getAllChannelConfigs();
}

function clearCache(channelId) {
  return getReader().clearCache(channelId);
}

module.exports = {
  getChannelConfig,
  getChannelConfigByLabel,
  getAllChannelConfigs,
  clearCache,
};
