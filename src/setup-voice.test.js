'use strict';
// scripts/setup-voice.js, checked where it can be checked from Linux.
//
// The script exists to make the Windows build self-sufficient on a clean
// runner, and on the runner it failed in four seconds with one unreadable line.
// These tests cover the parts that decide whether a failure is a bad download,
// a bad zip, or a release that changed shape — the parts that were silent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const setup = require('../scripts/setup-voice');

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2048, 1)]);
const HTML = Buffer.from('<!DOCTYPE html><html><body>Rate limited</body></html>');
const PAGE = Buffer.concat([HTML, Buffer.alloc(1024, 32)]);

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nus-setup-voice-'));
}

// A fetch that returns each response once, in order, then repeats the last.
function fakeFetch(responses) {
  let i = 0;
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

const body = (buf, status = 200, statusText = 'OK') => ({
  ok: status < 400,
  status,
  statusText,
  arrayBuffer: async () => buf,
});

// Never actually sleeps: the retry is the behaviour under test, not the wait.
const noWait = async () => {};

test('a zip is recognised by its first bytes, and an error page is not', () => {
  assert.equal(setup.looksLikeZip(ZIP), true);
  assert.equal(setup.looksLikeZip(PAGE), false, 'an HTML page saved as .zip is not a zip');
  assert.equal(setup.looksLikeZip(Buffer.alloc(0)), false);
  assert.equal(setup.looksLikeZip(Buffer.from('PK')), false, 'a truncated magic is not enough');
});

test('a download that fails is retried, and the retry is what gets kept', async () => {
  const dir = tmpdir();
  const dest = path.join(dir, 'whisper-bin-x64.zip');
  const fetch = fakeFetch([body(HTML, 503, 'Service Unavailable'), body(ZIP)]);
  const bytes = await setup.download('https://example.invalid/x.zip', dest, {
    zip: true, minBytes: 4, fetchImpl: fetch, wait: noWait,
  });
  assert.equal(bytes, ZIP.length);
  assert.deepEqual(fs.readFileSync(dest), ZIP, 'the good response is the file on disk');
  assert.equal(fetch.calls.length, 2, 'one failure, one retry');
});

test('an HTTP error is not written to disk, and gives up after the retries', async () => {
  const dir = tmpdir();
  const dest = path.join(dir, 'model.bin');
  const fetch = fakeFetch([body(HTML, 404, 'Not Found')]);
  await assert.rejects(
    setup.download('https://example.invalid/model.bin', dest, { minBytes: 4, fetchImpl: fetch, wait: noWait }),
    /HTTP 404 Not Found .*gave up after 3 attempts/,
  );
  assert.equal(fetch.calls.length, setup.ATTEMPTS);
  assert.equal(fs.existsSync(dest), false, 'nothing half-written is left behind for the next run to trust');
});

test('an HTML page served with a 200 is refused, not unpacked later', async () => {
  const dir = tmpdir();
  const dest = path.join(dir, 'whisper-bin-x64.zip');
  await assert.rejects(
    setup.download('https://example.invalid/x.zip', dest, { zip: true, minBytes: 4, fetchImpl: fakeFetch([body(PAGE)]), wait: noWait }),
    /not a zip/,
  );
  assert.equal(fs.existsSync(dest), false);
});

test('a body too small to be the real file is refused', async () => {
  const dir = tmpdir();
  await assert.rejects(
    setup.download('https://example.invalid/x.zip', path.join(dir, 'x.zip'), {
      zip: true, minBytes: 1 << 20, fetchImpl: fakeFetch([body(ZIP)]), wait: noWait,
    }),
    /only \d+ bytes, expected at least 1048576/,
  );
});

test('a zip that has already been unpacked is not downloaded again', () => {
  // findExe is what the script asks: a vendor/whisper with the binary in it is
  // a finished download, whichever run made it.
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'nested', 'deeper'), { recursive: true });
  assert.equal(setup.findExe(dir), null, 'an empty tree has no binary');
  const exe = path.join(dir, 'nested', 'deeper', 'whisper-cli.exe');
  fs.writeFileSync(exe, 'MZ');
  assert.equal(setup.findExe(dir), exe, 'found however deep the zip nested it');
  // The name decides before the depth does: whisper-cli is the current binary
  // and main.exe is the old one, so a nested whisper-cli still wins.
  fs.writeFileSync(path.join(dir, 'main.exe'), 'MZ');
  assert.equal(setup.findExe(dir), exe, 'whisper-cli.exe beats a shallower main.exe');
  fs.rmSync(exe);
  assert.equal(setup.findExe(dir), path.join(dir, 'main.exe'), 'and main.exe is the fallback the app also reads');
});

test('a tool that exits 0 and extracts nothing has not extracted', async () => {
  // The bug CI found: Expand-Archive reported success, wrote no file, and the
  // step carried on to fail with "binary not found" a few lines later. A
  // PowerShell error record is not an exception unless $ErrorActionPreference
  // says so, so the exit code is not evidence — the bytes on disk are.
  const dir = tmpdir();
  const zip = path.join(dir, 'whisper-bin-x64.zip');
  fs.writeFileSync(zip, ZIP);
  const dest = path.join(dir, 'out');
  fs.mkdirSync(dest);

  const tools = [
    { label: 'Expand-Archive', exe: 'powershell.exe', args: [] },
    { label: 'tar.exe', exe: 'tar.exe', args: [] },
  ];
  const run = (exe) => {
    if (exe === 'tar.exe') {
      fs.writeFileSync(path.join(dest, 'whisper-cli.exe'), 'MZ');
      return { ok: true, output: '' };
    }
    // Exit 0, no files, and a message that used to be discarded.
    return { ok: true, output: 'Expand-Archive : The archive entry was compressed using an unsupported compression method.' };
  };

  const added = setup.extract(zip, dest, { tools, run });
  assert.equal(added, 1, 'the second tool is the one that worked');
  assert.equal(fs.existsSync(path.join(dest, 'whisper-cli.exe')), true);
});

test('and if no tool extracts anything, the message carries what they said', async () => {
  const dir = tmpdir();
  const dest = path.join(dir, 'out');
  fs.mkdirSync(dest);
  const tools = [{ label: 'Expand-Archive', exe: 'powershell.exe', args: [] }];
  await assert.rejects(
    async () => setup.extract(path.join(dir, 'x.zip'), dest, { tools, run: () => ({ ok: true, output: 'nothing to see' }) }),
    /Expand-Archive: exited 0 but extracted 0 files after: nothing to see/,
  );
  await assert.rejects(
    async () => setup.extract(path.join(dir, 'x.zip'), dest, {
      tools, run: () => ({ ok: false, output: 'Cannot open file\r\nas it is not a valid archive' }),
    }),
    /Cannot open file \| as it is not a valid archive/,
    'a multi-line tool message becomes one readable line',
  );
});

test('the PowerShell attempt asks for terminating errors', () => {
  // Otherwise the cmdlet writes an error and the process still exits 0.
  const [, expand] = setup.defaultTools('a.zip', 'out');
  const [powershell] = setup.defaultTools('a.zip', 'out');
  assert.match(powershell.args.join(' '), /\$ErrorActionPreference = 'Stop'/);
  assert.match(powershell.args.join(' '), /Expand-Archive -LiteralPath/);
  assert.match(expand.exe, /tar\.exe$/);
});

test('a versioned CLI is accepted, renamed to the name the app spawns', () => {
  // The release zip carries whatever name the build produced. whisper-cli.exe
  // is what src/stt-local.js spawns, so a versioned spelling is adopted and
  // renamed rather than shipped under a name nothing looks for.
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'whisper-cli-b4938.exe'), 'MZ');
  fs.writeFileSync(path.join(dir, 'ggml.dll'), 'x');
  const found = setup.findExe(dir);
  assert.equal(path.basename(found), 'whisper-cli-b4938.exe');
  const exe = setup.adopt(dir, found);
  assert.equal(path.basename(exe), 'whisper-cli.exe');
  assert.equal(setup.findExe(dir), path.join(dir, 'whisper-cli.exe'), 'and it is found by the app');
  setup.prune(dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['ggml.dll', 'whisper-cli.exe'], 'prune keeps the binary it was given');
});

test('a different program in the same zip is never mistaken for the CLI', () => {
  // whisper-server.exe and whisper-cli.exe take different arguments; adopting
  // the wrong one produces a binary that is present and cannot transcribe.
  const dir = tmpdir();
  for (const name of ['whisper-server.exe', 'whisper-bench.exe', 'whisper-talk-llama.exe', 'whisper-client.exe']) {
    fs.writeFileSync(path.join(dir, name), 'MZ');
  }
  assert.equal(setup.findExe(dir), null, 'none of these is the CLI');
  setup.prune(dir);
  assert.deepEqual(fs.readdirSync(dir), [], 'and none of them is kept either');
});

test('main.exe is the old name for the same program, and keeps its own name', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'main.exe'), 'MZ');
  const exe = setup.adopt(dir, setup.findExe(dir));
  assert.equal(path.basename(exe), 'main.exe', 'nothing is renamed that the app already looks for');
});

test('the nesting is flattened, and only what whisper-cli needs is kept', () => {
  const dir = tmpdir();
  const nested = path.join(dir, 'Release');
  fs.mkdirSync(nested);
  const exe = path.join(nested, 'whisper-cli.exe');
  for (const name of ['whisper-cli.exe', 'ggml.dll', 'whisper.dll', 'whisper-bench.exe', 'README.md']) {
    fs.writeFileSync(path.join(nested, name), 'x');
  }
  fs.mkdirSync(path.join(nested, 'models'));
  fs.writeFileSync(path.join(nested, 'models', 'for-tests.bin'), 'x');

  setup.flatten(dir, exe);
  setup.prune(dir);

  assert.deepEqual(fs.readdirSync(dir).sort(), ['ggml.dll', 'whisper-cli.exe', 'whisper.dll'].sort());
  assert.equal(setup.findExe(dir), path.join(dir, 'whisper-cli.exe'));
  assert.equal(fs.existsSync(path.join(dir, 'models')), false, 'the demos and benches do not ship');
});

test('flatten does not overwrite nothing, and does not leave a duplicate', () => {
  const dir = tmpdir();
  const nested = path.join(dir, 'bin');
  fs.mkdirSync(nested);
  const exe = path.join(nested, 'whisper-cli.exe');
  fs.writeFileSync(path.join(dir, 'ggml.dll'), 'old');
  fs.writeFileSync(path.join(nested, 'ggml.dll'), 'new');
  fs.writeFileSync(exe, 'MZ');
  setup.flatten(dir, exe);
  assert.equal(fs.readFileSync(path.join(dir, 'ggml.dll'), 'utf8'), 'new', 'the extracted copy wins');
});

test('a zip with no binary in it says what it did contain', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  const tree = setup.listTree(dir);
  assert.match(tree, /README\.md/, 'the names, not the word "not found"');
  assert.match(setup.listTree(tmpdir()), /^\(nothing\)$/);
});

test('requiring the script does not run it', () => {
  // The CLI guard matters: this file runs `main` on import otherwise, and
  // these tests run on Linux, where main() exits 1 by design.
  assert.equal(typeof setup.main, 'function');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'), /"setup:voice": "node scripts\/setup-voice\.js"/);
});

test('the pinned release the script downloads is the one the workflow caches', () => {
  // The cache key names the tag, so rotating the pin in one place and not the
  // other would ship a whisper binary the cache never had.
  const tag = setup.BIN_URL.match(/whisper\.cpp\/releases\/download\/([^/]+)\//)[1];
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'build-windows.yml'), 'utf8');
  assert.match(workflow, new RegExp('key: whisper-' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-'), 'the cache key carries the same tag');
});
