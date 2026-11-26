// One JSON file for everything the person tuned, keys included: userData/settings.json.
//
// The split used to be SQLite for preferences and a directory of encrypted
// one-key files for secrets, which made "where are my settings" unanswerable and
// made a hand-copied settings folder silently incomplete. Now there is one file:
//
//   { "version": 1, "preferences": { ... }, "secrets": { ... } }
//
// The whole file is safeStorage-encrypted at rest when the OS keychain exists
// ({ encrypted: true, payload: <base64> }), and plain JSON with mode 0600 when it
// does not. Either way it is one file, it moves with a copy of the data folder,
// and the app re-reads it at boot, so updates never lose a setting.
//
// A file that will not parse is never overwritten: it is copied aside first,
// then the app starts from defaults and says so in status().main / status().
'use strict';

const fs = require('fs');
const path = require('path');

let file = null;
let safeStorage = null; // undefined = not asked yet, null = unavailable (plain JSON)
let data = { version: 1, preferences: {}, secrets: {} };
let readState = 'new';  // 'new' | 'ok' | 'migrated' | 'unreadable'
let readError = '';

function defaultSafeStorage() {
  try { return require('electron').safeStorage; } catch { return null; }
}
const available = () => Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());

// Copy the file aside before anything replaces it. The whole point is that a
// bad file is never silently destroyed; the person can see or restore it.
function keepAside(suffix) {
  try {
    const copy = file + '.' + suffix + '-' + Date.now();
    if (fs.existsSync(file)) fs.copyFileSync(file, copy);
    return copy;
  } catch { return null; }
}

function freshDefaults() {
  return { version: 1, preferences: {}, secrets: {} };
}

function parsePayload(raw) {
  const parsed = JSON.parse(raw);
  if (parsed && parsed.encrypted && typeof parsed.payload === 'string') {
    if (!available()) throw new Error('settings were written on a machine with keychain encryption and cannot be read here');
    return JSON.parse(safeStorage.decryptString(Buffer.from(parsed.payload, 'base64')));
  }
  return parsed;
}

function loadFromDisk() {
  if (!fs.existsSync(file)) { readState = 'new'; return freshDefaults(); }
  try {
    const parsed = parsePayload(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const out = freshDefaults();
    if (parsed.preferences && typeof parsed.preferences === 'object' && !Array.isArray(parsed.preferences)) out.preferences = parsed.preferences;
    if (parsed.secrets && typeof parsed.secrets === 'object' && !Array.isArray(parsed.secrets)) out.secrets = parsed.secrets;
    readState = 'ok';
    return out;
  } catch (error) {
    keepAside('corrupt');
    readState = 'unreadable';
    readError = String((error && error.message) || error);
    return freshDefaults();
  }
}

function persist() {
  const payload = JSON.stringify({ version: 1, preferences: data.preferences, secrets: data.secrets }, null, 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // tmp + rename: a crash mid-write leaves the previous file intact.
  const tmp = file + '.tmp-' + process.pid;
  const body = available()
    ? JSON.stringify({ encrypted: true, payload: safeStorage.encryptString(payload).toString('base64') }, null, 2)
    : payload;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return available();
}

// One-way fold of the two legacy stores into this file, first launch only:
// the SQLite preferences table (passed in by the caller so this module has no
// database dependency) and userData/secrets/*.{enc,plain}. Missing keys only.
function seedFromLegacy(userDataDir, legacyPreferences) {
  let touched = false;
  // Preferences from SQLite.
  try {
    const legacy = typeof legacyPreferences === 'function' ? legacyPreferences() : null;
    if (legacy && typeof legacy === 'object') {
      for (const [key, value] of Object.entries(legacy)) {
        if (!(key in data.preferences)) { data.preferences[key] = value; touched = true; }
      }
    }
  } catch { /* the database is not open yet; prefs fold in at read time too */ }
  // The old single model pick becomes the per-provider pin for Claude.
  try {
    const prefs = data.preferences;
    if (typeof prefs.ai_model === 'string' && prefs.ai_model.trim() && !(prefs.desktop_models && typeof prefs.desktop_models === 'object')) {
      const clean = prefs.ai_model.trim();
      if (/^[\w][\w.\-/:@]{0,137}$/.test(clean)) prefs.desktop_models = { 'claude-code': clean, anthropic: clean };
    }
  } catch { /* leave the raw preference; nothing breaks */ }
  // Secrets from the old one-file-per-key layout.
  try {
    const dir = path.join(userDataDir, 'secrets');
    for (const entry of fs.readdirSync(dir)) {
      const match = /^(.*)\.(enc|plain)$/.exec(entry);
      if (!match) continue;
      const key = match[1];
      if (key in data.secrets) continue;
      const full = path.join(dir, entry);
      let value = null;
      if (match[2] === 'enc') {
        if (available()) { try { value = safeStorage.decryptString(fs.readFileSync(full)); } catch { value = null; } }
      } else {
        try { value = fs.readFileSync(full, 'utf8'); } catch { value = null; }
      }
      if (typeof value === 'string' && value) { data.secrets[key] = value; touched = true; }
    }
  } catch { /* no legacy dir, nothing to fold */ }
  if (touched && readState !== 'unreadable') { persist(); readState = 'migrated'; }
}

// init is idempotent: the first call wins (main passes the legacy preferences
// reader once at boot); later calls are no-ops so secrets.js can stay simple.
let initialized = false;
function init({ userDataDir, safeStorage: injected, legacyPreferences } = {}) {
  if (initialized) return;
  file = path.join(userDataDir, 'settings.json');
  safeStorage = injected !== undefined ? injected : defaultSafeStorage();
  const existed = fs.existsSync(file);
  data = loadFromDisk();
  if (!existed) seedFromLegacy(userDataDir, legacyPreferences);
  initialized = true;
}

const notReady = (what) => new Error(`settings: not initialized (${what})`);

function getPreferences() { if (!file) throw notReady('read preferences'); return { ...data.preferences }; }
function setPreference(key, value) {
  if (!file) throw notReady('write preference');
  if (typeof key !== 'string' || !key) throw new Error('settings: preference key must be a non-empty string');
  data.preferences[key] = value;
  return persist();
}
function getSecret(key) { if (!file) return null; const value = data.secrets[key]; return typeof value === 'string' ? value : null; }
function setSecret(key, value) {
  if (!file) throw notReady('write secret');
  data.secrets[key] = String(value);
  return persist();
}
function deleteSecret(key) { if (!file) return; delete data.secrets[key]; persist(); }
function clearPreferences() {
  if (!file) return { cleared: 0 };
  const cleared = Object.keys(data.preferences).length;
  data.preferences = {};
  persist();
  return { cleared };
}
function listSecrets() { return file ? Object.keys(data.secrets) : []; }
function isAvailable() { return available(); }
function status() {
  return { path: file, read: readState, error: readError, encrypted: available(), preferences: Object.keys(data.preferences).length, secrets: Object.keys(data.secrets).length };
}
function forget() { initialized = false; file = null; safeStorage = null; data = freshDefaults(); readState = 'new'; readError = ''; } // tests

module.exports = { init, getPreferences, setPreference, getSecret, setSecret, deleteSecret, listSecrets, isAvailable, status, clearPreferences, forget };
