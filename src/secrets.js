// Kept as a thin compatibility layer over src/settings-file.js, where keys now
// live alongside the rest of the settings in one JSON file. auth.js, gcal.js
// and outlook.js call these names; nothing about their contract changes, and
// the old userData/secrets/*.enc layout is folded into the JSON file on first
// launch by settings-file.js (the old files are left in place as a backup).
'use strict';

const settingsFile = require('./settings-file');

function init(userDataDir) {
  // Main calls settingsFile.init({ userDataDir, legacyPreferences }) once at
  // boot; this stays so existing holders of this module keep working.
  settingsFile.init({ userDataDir });
}

function isAvailable() { return settingsFile.isAvailable(); }
function setSecret(key, value) { return settingsFile.setSecret(key, value); }
function getSecret(key) { return settingsFile.getSecret(key); }
function deleteSecret(key) { return settingsFile.deleteSecret(key); }
function listSecrets() { return settingsFile.listSecrets(); }

module.exports = { init, setSecret, getSecret, deleteSecret, listSecrets, isAvailable };
