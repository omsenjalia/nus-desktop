// The test runner `npm test` calls, so that the globs are expanded by Node
// rather than by whatever shell npm happened to start.
//
// `node --test 'src/*.test.js' 'companion/test/*.test.js'` worked on Linux and
// lied on Windows. bash strips the quotes and lets Node expand the pattern;
// cmd.exe has no globbing and no single-quote quoting, so it passed the pattern
// through with its quote characters attached. Node matched no file, printed
// `# tests 0`, and exited 0 — a green Test step that tested nothing. The
// Windows job failed later, on a step that downloads a binary, while the suite
// it claimed to have run had never started.
//
// So: the expansion happens here, one list of directories, one meaning on every
// platform. And finding no tests is a failure, not a pass — the whole point of
// this file is that silence is not success.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

// Every directory that holds tests. One level deep, matching what the old
// quoted globs meant: companion/test/ask-routing is fixtures and simulators,
// not a suite. Add a directory here and its tests run everywhere.
const suites = ['src', 'companion/test'];

function collect(dir) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) throw new Error(`no such test directory: ${dir}`);
  return fs
    .readdirSync(full, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

const files = suites.flatMap(collect);

if (files.length === 0) {
  console.error(`no *.test.js files in ${suites.join(' or ')} — refusing to report a pass`);
  process.exit(1);
}

// stdio inherited on purpose: the CI step greps the TAP stream for the failing
// test names, and a pipe (which is what npm gives us) keeps the TAP reporter.
const run = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });

if (run.error) {
  console.error(run.error.message);
  process.exit(1);
}
if (run.signal) {
  console.error(`the test runner was killed by ${run.signal}`);
  process.exit(1);
}
process.exit(run.status == null ? 1 : run.status);
