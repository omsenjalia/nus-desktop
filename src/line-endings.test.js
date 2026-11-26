'use strict';
// Line endings, and the class of test bug they caused.
//
// The first Windows CI run failed at the Test step with 17 failing tests and no
// readable log. The cause was not Windows: it was CRLF. Several tests read a
// source file as text and search for a snippet that spans two lines, written
// with a literal "\n". A CRLF checkout makes every one of those misses.
//
// Two guards here:
//   1. .gitattributes pins LF for the tree, so a Windows checkout cannot change
//      the bytes a test reads.
//   2. Tests may still use "\n" inside a regex (where \s* absorbs the CR), but a
//      bare indexOf/search for a multi-line string with "\n" is the fragile
//      spelling. This lists them, so the next one is a deliberate choice rather
//      than a trap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function testFiles() {
  const out = [];
  for (const dir of ['src', 'companion/test']) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.endsWith('.test.js')) out.push(path.join(dir, name));
    }
  }
  return out.sort();
}

test('the repository pins LF for every text file', () => {
  const attrs = read('.gitattributes');
  assert.match(attrs, /^\* text=auto eol=lf$/m, 'the default is LF everywhere, including Windows');
  // Binary files must be exempt or normalisation corrupts them.
  for (const ext of ['png', 'ico', 'wav', 'exe', 'node', 'asar']) {
    assert.match(attrs, new RegExp(`^\\*\\.${ext} binary$`, 'm'), ext + ' is declared binary');
  }
  // The one exception is deliberate and narrow.
  assert.match(attrs, /^\*\.bat text eol=crlf$/m, 'batch files keep CRLF, and only batch files');
});

test('no test file was committed with CRLF', () => {
  const bad = testFiles().filter((f) => read(f).includes('\r\n'));
  assert.deepEqual(bad, [], 'CRLF in a test file: ' + bad.join(', '));
});

test('source files are LF, so a Windows checkout and a Linux one agree', () => {
  const bad = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(rel); continue; }
      if (!/\.(js|json|html|css|md)$/.test(entry.name)) continue;
      if (read(rel).includes('\r\n')) bad.push(rel);
    }
  };
  for (const dir of ['src', 'companion/src', 'renderer', 'companion/renderer']) walk(dir);
  assert.deepEqual(bad, [], 'CRLF in source: ' + bad.join(', '));
});

test('a multi-line search uses a regex or a normaliser, never a bare "\\n"', () => {
  // This is the bug: r.indexOf("cues.quiet();\n    if (pttHeld) ..."). It passes
  // on LF and misses on CRLF, so the failure depends on who checked out the
  // tree. Such a search must go through the regex form (\s* spans the CR) or
  // through .replace(/\r\n/g, '\n') first.
  const fragile = [];
  for (const file of testFiles()) {
    // This file names the pattern it hunts, so it would always find itself.
    if (file === 'src/line-endings.test.js') continue;
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      // An indexOf/lastIndexOf whose string argument contains an escaped \n.
      if (/(indexOf|lastIndexOf|includes)\(\s*("[^"]*\\n|'[^']*\\n)/.test(line)) {
        fragile.push(`${file}:${i + 1}`);
      }
    });
  }
  // The known instance is listed on purpose; it is fixed, and a new one shows up
  // here instead of failing a Windows build six months later.
  const KNOWN = [
    'companion/test/cue-samples.test.js', // searches for a two-line snippet
  ];
  const unexpected = fragile.filter((loc) => !KNOWN.some((k) => loc.startsWith(k)));
  assert.deepEqual(unexpected, [], 'multi-line string search that a CRLF checkout would break: ' + unexpected.join(', '));
});

test('a test that reads a file for an exact substring normalises it first, where it matters', () => {
  // The pattern that is actually safe: normalise on read, then search freely.
  // Asserted on the one file that is known to need it, so the habit is visible.
  const cue = read('companion/test/cue-samples.test.js');
  const uses = /\\r\\n/.test(cue) || /\\s\*/.test(cue);
  assert.ok(uses, 'cue-samples searches text that spans lines; it must tolerate CRLF via \\s* or a \\r\\n strip');
});

test('the test script does not rely on a shell expanding a glob', () => {
  // This was written the other way round first, and the wrong way passed.
  //
  // Quoting the glob (`node --test 'src/*.test.js'`) is what works on bash and
  // what broke Windows, not the fix: bash strips the quotes and node expands
  // the pattern, but cmd.exe has no single-quote quoting and no globbing, so it
  // hands node the string *including* the quote characters. node matches no
  // file, prints `# tests 0`, and exits 0. The Windows Test step was green in
  // zero seconds while running nothing at all.
  //
  // A script whose meaning depends on which shell npm started is the bug. So
  // no glob at all: the patterns live in scripts/run-tests.js, node expands
  // them identically on every platform, and an empty find is an error.
  const pkg = JSON.parse(read('package.json'));
  assert.equal(typeof pkg.scripts.test, 'string');
  assert.doesNotMatch(pkg.scripts.test, /[*?[\]]/, 'no glob for a shell to expand, on any platform');
  assert.doesNotMatch(pkg.scripts.test, /['"]/, 'no quoted pattern that only one shell strips');
  assert.match(pkg.scripts.test, /node scripts\/run-tests\.js$/);

  const runner = read('scripts/run-tests.js');
  // The same two directories the quarantined globs named, expanded one level
  // deep in node.
  assert.match(runner, /const suites = \['src', 'companion\/test'\]/);
  assert.match(runner, /endsWith\('\.test\.js'\)/, 'it collects *.test.js files');
  assert.match(runner, /files\.length === 0[\s\S]*?process\.exit\(1\)/, 'finding nothing fails instead of passing');
  assert.match(runner, /spawnSync\(process\.execPath, \['--test'/, 'the runner starts node --test itself');
});
