'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The whole point of the settings file: one JSON file holds preferences and
// keys, it survives updates, it never destroys an unreadable file, and keys
// pasted in any provider land in that same file. These tests run against a
// temp dir with an injected keychain so nothing touches the real userData.
const settingsFile = require('./settings-file');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'settings-file-test-')); }
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('enc(' + s + ')', 'utf8'),
    decryptString: (buf) => String(buf).slice(4, -1),
  };
}
function init(dir, { injected, legacyPreferences } = {}) {
  settingsFile.forget();
  settingsFile.init({ userDataDir: dir, safeStorage: injected === undefined ? fakeSafeStorage(false) : injected, legacyPreferences });
}

test('round trip: a preference set now is read back after a re-init (the update case)', () => {
  const dir = tempDir();
  init(dir, { injected: null });
  settingsFile.setPreference('theme', 'nus');
  settingsFile.setSecret('desktop_key_gemini', 'AIza-test-key');
  // Simulate an app update: brand new module state, same folder.
  init(dir, { injected: null });
  const prefs = settingsFile.getPreferences();
  assert.equal(prefs.theme, 'nus');
  assert.equal(settingsFile.getSecret('desktop_key_gemini'), 'AIza-test-key');
  assert.equal(settingsFile.status().read, 'ok');
});

test('legacy SQLite preferences and userData/secrets files are folded into the JSON file on first launch', () => {
  const dir = tempDir();
  // Legacy: a safeStorage-encrypted secrets file and a plain one, as the old layout wrote them.
  const secretsDir = path.join(dir, 'secrets');
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(path.join(secretsDir, 'anthropic_api_key.plain'), 'sk-ant-legacy', { mode: 0o600 });
  init(dir, { injected: null, legacyPreferences: () => ({ theme: 'nus', ai_model: 'claude-sonnet-5' }) });
  assert.equal(settingsFile.getPreferences().theme, 'nus');
  assert.equal(settingsFile.getPreferences().ai_model, 'claude-sonnet-5');
  assert.equal(settingsFile.getSecret('anthropic_api_key'), 'sk-ant-legacy');
  assert.equal(settingsFile.status().read, 'migrated');
  // The folded values are in the one file now.
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
  // The old single model pick becomes the per-provider pin for Claude.
  assert.equal(settingsFile.getPreferences().desktop_models['claude-code'], 'claude-sonnet-5');
});

test('an unreadable settings file is kept aside, never overwritten, and the app starts on defaults', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json', { mode: 0o600 });
  init(dir, { injected: null });
  const status = settingsFile.status();
  assert.equal(status.read, 'unreadable');
  assert.deepEqual(settingsFile.getPreferences(), {});
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith('settings.json.corrupt-'));
  assert.equal(aside.length, 1, 'the bad file was copied aside');
});

test('when a keychain exists the file is encrypted at rest, not plaintext JSON', () => {
  const dir = tempDir();
  init(dir, { injected: fakeSafeStorage(true) });
  settingsFile.setSecret('desktop_key_groq', 'gsk_secret_value');
  const raw = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  assert.ok(!raw.includes('gsk_secret_value'), 'the key never touches the disk in plaintext');
  assert.match(raw, /"encrypted": true/);
  if (process.platform !== 'win32') {
    // POSIX modes round-trip only off Windows; on Windows the mode bits are
    // ignored and stat reports a default, which proves nothing either way.
    const mode = fs.statSync(path.join(dir, 'settings.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  // And it comes back through the keychain.
  init(dir, { injected: fakeSafeStorage(true) });
  assert.equal(settingsFile.getSecret('desktop_key_groq'), 'gsk_secret_value');
});

test('clearPreferences drops every preference and keeps keys', () => {
  const dir = tempDir();
  init(dir, { injected: null });
  settingsFile.setPreference('theme', 'nus');
  settingsFile.setSecret('desktop_key_gemini', 'AIza-x');
  settingsFile.clearPreferences();
  assert.deepEqual(settingsFile.getPreferences(), {});
  assert.equal(settingsFile.getSecret('desktop_key_gemini'), 'AIza-x');
});

test('the desktop provider matrix: parsing, models, base URLs, key names', () => {
  const matrix = require('./ai-providers');
  const prefs = { desktop_provider: 'gemini', desktop_models: { gemini: 'gemini-3.6-pro' }, desktop_base_url: 'https://example.test/v1' };
  assert.equal(matrix.desktopProviderChoice(prefs), 'gemini');
  assert.equal(matrix.desktopProviderChoice({ desktop_provider: 'nonsense' }), 'auto');
  assert.equal(matrix.desktopProviderChoice({}), 'auto');
  assert.equal(matrix.modelFor('gemini', prefs), 'gemini-3.6-pro');
  assert.equal(matrix.modelFor('groq', prefs), 'llama-3.3-70b-versatile');
  assert.equal(matrix.modelFor('claude-code', {}), 'claude-sonnet-5');
  assert.equal(matrix.modelFor('claude-code', { desktop_models: { 'claude-code': 'claude-haiku-4-5' } }), 'claude-haiku-4-5');
  assert.equal(matrix.desktopModelFor(prefs, 'gemini'), 'gemini-3.6-pro');
  assert.equal(matrix.baseUrlFor('groq', prefs), 'https://api.groq.com/openai/v1');
  assert.equal(matrix.baseUrlFor('custom', prefs), 'https://example.test/v1');
  assert.match(matrix.baseUrlFor('ollama', prefs, { OLLAMA_HOST: 'http://192.168.1.9:11434/' }), /192\.168\.1\.9:11434\/v1$/);
  assert.deepEqual(matrix.cleanModelId('gemini-3.6-flash'), { model: 'gemini-3.6-flash' });
  assert.equal(matrix.cleanModelId('not a model with spaces').error, 'bad_model_id');
  assert.deepEqual(matrix.cleanModelId(''), { model: '' });
  assert.deepEqual(matrix.cleanBaseUrl('https://example.test/v1'), { baseUrl: 'https://example.test/v1' });
  assert.equal(matrix.cleanBaseUrl('ftp://nope').error, 'bad_base_url');
  assert.equal(matrix.keyNameFor('anthropic'), 'anthropic_api_key');
  assert.equal(matrix.keyNameFor('gemini'), 'desktop_key_gemini');
  assert.equal(matrix.needsKey('ollama'), false);
  assert.equal(matrix.needsKey('custom'), false);
  assert.equal(matrix.needsKey('gemini'), true);
  // A key round-trips through the shared file under the provider key name.
  const dir = tempDir();
  init(dir, { injected: null });
  settingsFile.setSecret(matrix.keyNameFor('groq'), 'gsk_roundtrip');
  assert.equal(settingsFile.getSecret('desktop_key_groq'), 'gsk_roundtrip');
  settingsFile.deleteSecret(matrix.keyNameFor('groq'));
  assert.equal(settingsFile.getSecret('desktop_key_groq'), null);
});
