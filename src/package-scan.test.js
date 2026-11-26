'use strict';
// scripts/package-security-check.js, checked without building an app.
//
// The scan runs at the very end of the Windows build, after the installer is
// made, and for a long time no run got that far — so the stale entry in its
// list of required files had never executed. The first run that reached it
// failed on companion/renderer/strand.js, a renderer that other tests assert
// has been deleted. These tests check the scan's claims against the working
// tree, where the same mistake is a one-second failure.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scan = require('../scripts/package-security-check');

const root = path.join(__dirname, '..');
const builder = require('../electron-builder.config');

test('every file the scan requires is in the tree', () => {
  const missing = scan.required.filter((entry) => !fs.existsSync(path.join(root, entry)));
  assert.deepEqual(missing, [], 'required by the scan but not in the repository: ' + missing.join(', '));
});

test('and every one of them is packed, so the check is about the app and not the source tree', () => {
  // The builder's files list decides what reaches the asar. A required path
  // outside it could never be satisfied by a correct build.
  const packed = builder.files;
  const allowedBy = (entry) => packed.some((glob) => !glob.startsWith('!') && (glob === entry || (glob.endsWith('/**/*') && entry.startsWith(glob.slice(0, -4)))));
  const unreachable = scan.required.filter((entry) => !allowedBy(entry));
  assert.deepEqual(unreachable, [], 'required by the scan but excluded from the app: ' + unreachable.join(', '));

  for (const glob of packed.filter((g) => g.startsWith('!'))) {
    const excluded = glob.replace('!', '').replace('/**', '');
    assert.ok(!scan.required.some((entry) => entry.startsWith(excluded)), glob + ' excludes something the scan requires');
  }
});

test('the file that replaced strand.js is required, and strand.js is not', () => {
  assert.ok(scan.required.includes('companion/renderer/knot-engine.js'), 'the thread engine ships and is checked');
  assert.ok(!scan.required.includes('companion/renderer/strand.js'), 'a deleted renderer cannot be required');
  // The peer test that pins the deletion, so the two cannot drift apart.
  const strand = fs.readFileSync(path.join(root, 'companion/test/strand.test.js'), 'utf8');
  assert.match(strand, /strand\.js'\)\)/, 'strand.test.js still asserts the old renderer is gone');
});

test('what must not ship is caught, wherever it sits', () => {
  for (const entry of ['.env', '.env.local', 'src/.env', 'docs/release.md', 'scripts/setup-voice.js', 'supabase/config.toml', 'src/main.test.js', 'companion/test/x.test.js', 'renderer/theme.test.js', 'AGENTS.md', 'deno.lock']) {
    assert.equal(scan.isForbidden(entry), true, entry + ' must be refused');
  }
});

test('and what ships normally is not caught by accident', () => {
  for (const entry of ['src/main.js', 'companion/renderer/knot-engine.js', 'node_modules/sql.js/dist/sql-wasm.wasm', 'package.json', 'node_modules/@supabase/auth-js/AGENTS.md']) {
    assert.equal(scan.isForbidden(entry), false, entry + ' is allowed');
  }
});

test('every secret pattern still bites', () => {
  const samples = {
    private_key: '-----BEGIN OPENSSH PRIVATE KEY-----',
    stripe_secret: 'sk_live_' + 'a'.repeat(24),
    stripe_webhook_secret: 'whsec_' + 'b'.repeat(24),
    anthropic_key: 'sk-ant-' + 'c'.repeat(24),
    openai_key: 'sk-proj-' + 'd'.repeat(40),
    google_api_key: 'AIza' + 'e'.repeat(35),
    github_token: 'ghp_' + 'f'.repeat(24),
    aws_access_key: 'AKIA' + 'G'.repeat(16),
  };
  for (const [kind, pattern] of scan.patterns) {
    const sample = samples[kind];
    assert.ok(sample, 'no sample for ' + kind + ': a pattern with no test is a pattern nobody knows works');
    pattern.lastIndex = 0;
    assert.equal([...sample.matchAll(pattern)].length, 1, kind + ' matches its own sample');
  }
  assert.equal(scan.patterns.length, Object.keys(samples).length, 'every pattern has a sample');
});

test('with no build present, the scan says which paths it looked at', () => {
  const code = scan.main(['node', 'scan', path.join(root, 'dist', 'nope', 'app.asar')]);
  assert.equal(code, 1, 'a missing app is a failure, not a pass');
});
