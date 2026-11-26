'use strict';
// scripts/write-config.js, run for real.
//
// This script is what a clean CI checkout uses to make src/config.js, and its
// first run in CI failed on a rule it enforces itself: an empty value counted
// as missing, so a personal build with no server could not generate a config at
// all. These tests run the script in a scratch directory rather than reading
// its source, because the bug was in its behaviour, not its text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'write-config.js');

// A throwaway tree with the script in the place it expects (scripts/ beside src/).
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'write-config-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  // src/ exists in a real checkout; the script writes into it and does not
  // create it. A sandbox without it was testing the sandbox.
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'write-config.js'));
  return root;
}

function run(root, args = [], env = {}) {
  // A clean environment on purpose: PATH and nothing else, so a variable set in
  // this shell cannot make a "missing value" test pass by accident.
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'write-config.js'), ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}

const readConfig = (root) => require(path.join(root, 'src', 'config.js'));

test('with nothing set it refuses, and says how to proceed', () => {
  const root = sandbox();
  const r = run(root);
  assert.equal(r.code, 1, 'a missing config is a failure by default');
  assert.match(r.out, /--allow-empty/, 'the error names the way out');
  assert.ok(!fs.existsSync(path.join(root, 'src', 'config.js')), 'and writes nothing');
});

test('--allow-empty writes a config whose values are empty strings', () => {
  const root = sandbox();
  const r = run(root, ['--allow-empty']);
  assert.equal(r.code, 0, r.out);
  const cfg = readConfig(root);
  // "" and not "undefined": the app tests these by truthiness, and the string
  // "undefined" is truthy. This was the second bug in the same step.
  assert.equal(cfg.supabase.url, '');
  assert.equal(cfg.googleCalendar.clientId, '');
  assert.equal(cfg.outlook.clientId, '');
  assert.equal(cfg.isSupabaseConfigured(cfg), false);
  assert.equal(cfg.isGoogleCalendarConfigured(cfg), false);
  assert.equal(cfg.isOutlookConfigured(cfg), false);
});

test('a real value is carried through, and one half of a pair is not enough', () => {
  const root = sandbox();
  const id = 'abc.apps.googleusercontent.com';
  assert.equal(run(root, ['--allow-empty'], { NUS_GCAL_CLIENT_ID: id }).code, 0);
  let cfg = readConfig(root);
  assert.equal(cfg.googleCalendar.clientId, id, 'the value survives the write');
  // Google needs an id and a secret together. An id alone is written but not
  // configured, which is the right answer and the one the app acts on.
  assert.equal(cfg.isGoogleCalendarConfigured(cfg), false, 'half a client is not configured');
  assert.equal(cfg.isOutlookConfigured(cfg), false, 'and the others stay unconfigured');

  const full = sandbox();
  assert.equal(run(full, ['--allow-empty'], { NUS_GCAL_CLIENT_ID: id, NUS_GCAL_CLIENT_SECRET: 'shh' }).code, 0);
  cfg = readConfig(full);
  assert.equal(cfg.isGoogleCalendarConfigured(cfg), true, 'both halves is configured');
  assert.equal(readConfig(full).googleCalendar.clientSecret, 'shh');
});

test('every value is given, so the strict path still works', () => {
  const root = sandbox();
  const all = {
    NUS_SUPABASE_URL: 'https://x.supabase.co',
    NUS_SUPABASE_ANON_KEY: 'anon',
    NUS_GCAL_CLIENT_ID: 'g',
    NUS_GCAL_CLIENT_SECRET: 'gs',
    NUS_OUTLOOK_CLIENT_ID: 'o',
  };
  const r = run(root, [], all);
  assert.equal(r.code, 0, r.out);
  const cfg = readConfig(root);
  assert.equal(cfg.supabase.url, 'https://x.supabase.co');
  assert.equal(cfg.isOutlookConfigured(cfg), true);
  assert.doesNotMatch(r.out, /--allow-empty/, 'nothing is announced as empty');
});

test('a value is the one that was given, even with the variable still set to something else later', () => {
  // The written file used to read process.env at run time, so a variable set to
  // '' in CI could override the value the generator wrote and look configured.
  const root = sandbox();
  run(root, ['--allow-empty'], { NUS_GCAL_CLIENT_ID: 'from-the-run' });
  const src = fs.readFileSync(path.join(root, 'src', 'config.js'), 'utf8');
  assert.doesNotMatch(src, /process\.env\.NUS_/, 'the file carries values, not env reads');
});

test('it will not clobber an existing config without --force', () => {
  const root = sandbox();
  assert.equal(run(root, ['--allow-empty']).code, 0);
  const before = fs.readFileSync(path.join(root, 'src', 'config.js'), 'utf8');
  const again = run(root, ['--allow-empty']);
  assert.equal(again.code, 1, 'a second run refuses');
  assert.match(again.out, /--force/);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'config.js'), 'utf8'), before, 'the file is untouched');
  assert.equal(run(root, ['--allow-empty', '--force']).code, 0, 'and --force overwrites');
});
