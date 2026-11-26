// Downloads the whisper.cpp Windows binary and the base English model for local voice.
// Usage: npm run setup:voice [-- --small]
//
// This runs on a CI runner with no cache, over a network nobody controls, and
// the failure it produced there was one line in a log that could not be read:
// the step went red in four seconds and said only "exit code 1". So every part
// of it that can fail now says what failed and why:
//
//   - downloads are retried, and a response is checked before it is kept: an
//     error page saved as whisper-bin-x64.zip extracts to nothing and looks
//     exactly like a bad release;
//   - extraction tries the PowerShell cmdlet and then the bsdtar that Windows
//     ships, because "Expand-Archive failed" is not a diagnosis;
//   - a missing exe lists what the zip actually contained.
//
// The helpers are exported and the CLI entry is guarded, so the checks below
// can be tested on Linux, where this script does not otherwise run.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WHISPER_TAG = 'b4938';
const BIN_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}/whisper-bin-x64.zip`;
const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin';
const MODEL_SMALL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin';

// A retry exists because a GitHub release download is the one request in this
// script that fails for reasons that are nobody's fault.
const ATTEMPTS = 3;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
// Smaller than any real whisper zip (8 MB) or model (57 MB), larger than any
// error page or empty redirect body.
const MIN_BYTES = 256 * 1024;

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'vendor', 'whisper');
const modelDir = path.join(root, 'vendor', 'whisper-models');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function looksLikeZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= ZIP_MAGIC.length && buf.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC);
}

async function fetchOnce(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`empty response from ${url}`);
  return buf;
}

// Download to dest, retrying, and keep nothing that failed a check: a
// half-written or error-page file left in vendor/whisper would be treated as a
// finished download by the next run, and by findExe.
async function download(url, dest, { zip = false, minBytes = MIN_BYTES, fetchImpl = fetch, wait = sleep, attempts = ATTEMPTS } = {}) {
  console.log(`Downloading ${url}`);
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const buf = await fetchOnce(url, fetchImpl);
      if (zip && !looksLikeZip(buf)) {
        throw new Error(`not a zip: it starts with ${JSON.stringify(buf.subarray(0, 16).toString('latin1'))} (an error page saved as a download?)`);
      }
      if (buf.length < minBytes) throw new Error(`only ${buf.length} bytes, expected at least ${minBytes}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      console.log(`  saved ${dest} (${(buf.length / 1048576).toFixed(1)} MB)`);
      return buf.length;
    } catch (err) {
      last = err;
      try { fs.rmSync(dest, { force: true }); } catch { /* nothing to remove */ }
      if (attempt < attempts) {
        const delay = attempt * 2000;
        console.log(`  attempt ${attempt}/${attempts} failed (${err.message}); retrying in ${delay / 1000}s`);
        await wait(delay);
      }
    }
  }
  throw new Error(`${last && last.message} (gave up after ${attempts} attempts)`);
}

// The CLI has been renamed once already (main.exe became whisper-cli.exe), and
// the release zip carries whatever name the build produced, sometimes with the
// version in it. The app spawns whisper-cli.exe (src/stt-local.js), so a
// versioned spelling is accepted here and renamed on the way in — but never
// something like whisper-server.exe or whisper-bench.exe, which are different
// programs that would answer the wrong arguments.
const EXE_NAMES = ['whisper-cli.exe', 'main.exe'];
const EXE_PATTERN = /^(whisper-cli|main)(?:[-_.](?:b\d+|v?\d[\w.-]*))?\.exe$/i;

function findAll(dir, match) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (match(entry.name)) out.push(full);
    }
  }
  return out;
}

// The CLI in dir, however deep the zip nested it: the exact names first
// (whisper-cli.exe before main.exe), then a versioned spelling.
function findExe(dir) {
  const rank = (file) => EXE_NAMES.indexOf(path.basename(file).toLowerCase());
  const exact = findAll(dir, (name) => EXE_NAMES.includes(name.toLowerCase()));
  if (exact.length) return exact.sort((a, b) => rank(a) - rank(b))[0];
  const versioned = findAll(dir, (name) => EXE_PATTERN.test(name));
  if (versioned.length) {
    const isCli = (file) => path.basename(file).toLowerCase().startsWith('whisper-cli');
    return versioned.sort((a, b) => Number(isCli(b)) - Number(isCli(a)))[0];
  }
  return null;
}

// Move what sits beside the binary up into dir, then give the CLI the name the
// app spawns. main.exe is left alone: it is the old name for the same program
// and src/stt-local.js looks for both.
function adopt(dir, exe) {
  flatten(dir, exe);
  const here = path.join(dir, path.basename(exe));
  const wanted = path.join(dir, 'whisper-cli.exe');
  const base = path.basename(here).toLowerCase();
  if (base === 'whisper-cli.exe' || !base.startsWith('whisper-cli') || fs.existsSync(wanted)) return here;
  fs.renameSync(here, wanted);
  return wanted;
}

// Keep only what whisper-cli needs; the zip ships benches, tests and demos.
function prune(dir) {
  const keep = /^(?:whisper-cli(?:[-_.](?:b\d+|v?\d[\w.-]*))?\.exe|main\.exe|.*\.dll)$/i;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
    else if (!keep.test(entry.name)) fs.rmSync(full, { force: true });
  }
}

// Some release zips nest the binaries in a subfolder. Moving what sits beside
// the exe up to the root leaves one known layout for the app to find.
function flatten(dir, exe) {
  const from = path.dirname(exe);
  if (from === dir) return;
  for (const entry of fs.readdirSync(from)) {
    const src = path.join(from, entry);
    const dest = path.join(dir, entry);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(src, dest);
  }
}

// What is actually in the directory, for the error when it holds no exe. A
// list of names is the difference between "the zip changed" and guessing.
function listTree(dir, limit = 40) {
  const out = [];
  const walk = (d, prefix) => {
    if (out.length >= limit) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= limit) return;
      out.push(prefix + entry.name + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) walk(path.join(d, entry.name), prefix + entry.name + '/');
    }
  };
  walk(dir, '');
  return out.length ? out.join(', ') : '(nothing)';
}

// How many files are under a directory, for asking a tool whether it actually
// did anything. Expand-Archive exits 0 on a non-terminating error, and a
// PowerShell error record is not an exception, so the exit code proves nothing
// on its own: the first red run of this step reported success and put zero
// files on disk. The output is captured for the same reason - the reason it
// gave was going to stderr and being thrown away.
function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(d, entry.name));
      else n++;
    }
  };
  walk(dir);
  return n;
}

function runTool(exe, args) {
  try {
    const out = execFileSync(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return { ok: true, output: String(out || '').trim() };
  } catch (err) {
    const output = `${(err && err.stdout) || ''}\n${(err && err.stderr) || ''}`.trim() || String((err && err.message) || err);
    return { ok: false, output };
  }
}

const oneLine = (text, lines = 6) =>
  String(text || '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, lines).join(' | ');

// Expand-Archive first, because it is the platform's own unzipper and needs no
// download. Then System32\tar.exe, which reads zip and has shipped with
// Windows 10 and later: two independent tools means a bad download is
// distinguishable from a bad unzipper.
//
// A tool only counts as having worked if the file count went up. That check is
// the whole point: the tool that "succeeded" in CI extracted nothing.
function extract(zipPath, dest, { tools = defaultTools(zipPath, dest), run = runTool } = {}) {
  const failures = [];
  for (const tool of tools) {
    const before = countFiles(dest);
    const result = run(tool.exe, tool.args);
    const added = countFiles(dest) - before;
    if (result.ok && added > 0) return added;
    const detail = result.ok
      ? `exited 0 but extracted ${added} files${result.output ? ' after: ' + oneLine(result.output) : ''}`
      : oneLine(result.output) || 'failed with no output';
    failures.push(`${tool.label}: ${detail}`);
    console.log(`  ${tool.label} did not extract the zip: ${detail}`);
  }
  throw new Error(`could not extract ${zipPath}: ${failures.join(' ; ')}`);
}

function defaultTools(zipPath, dest) {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return [
    {
      label: 'Expand-Archive',
      exe: 'powershell.exe',
      // $ErrorActionPreference makes the cmdlet's non-terminating error a
      // failure, so the exit code means what it looks like it means.
      args: ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${dest}" -Force`],
    },
    { label: 'tar.exe', exe: tar, args: ['-xf', zipPath, '-C', dest] },
  ];
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('setup:voice downloads the Windows whisper.cpp build only; the Mac app ships without local voice for now.');
    console.error('On macOS: brew install whisper-cpp, then start Nus with NUS_WHISPER_DIR=$(brew --prefix)/bin and it finds whisper-cli there.');
    process.exit(1);
  }
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.mkdirSync(modelDir, { recursive: true });

  const zipPath = path.join(vendorDir, 'whisper-bin-x64.zip');
  if (!findExe(vendorDir)) {
    await download(BIN_URL, zipPath, { zip: true });
    const added = extract(zipPath, vendorDir);
    fs.rmSync(zipPath, { force: true });
    // The names, before anything is removed. The first red run of this step
    // said "binary not found" over a directory that pruning had already
    // emptied: a symptom with the evidence deleted. Now the log carries the
    // layout of whatever the release shipped, and how much of it arrived.
    console.log(`  extracted ${added} files: ${listTree(vendorDir, 20)}`);
  }
  // Identify before deleting, not after. The old order pruned what it did not
  // recognise and then reported that nothing was there.
  const found = findExe(vendorDir);
  if (!found) {
    throw new Error(`no whisper-cli.exe in ${path.relative(root, vendorDir)}; it contains: ${listTree(vendorDir)}`);
  }
  const exe = adopt(vendorDir, found);
  prune(vendorDir);
  if (!fs.existsSync(exe)) {
    throw new Error(`pruning vendor/whisper removed the binary it had just chosen (${path.relative(root, exe)})`);
  }
  console.log(`Binary ready: ${exe}`);

  const wantSmall = process.argv.includes('--small');
  const modelUrl = wantSmall ? MODEL_SMALL_URL : MODEL_BASE_URL;
  const modelPath = path.join(modelDir, path.basename(new URL(modelUrl).pathname));
  if (!fs.existsSync(modelPath)) await download(modelUrl, modelPath);
  console.log(`Model ready: ${modelPath}`);
  console.log('Voice setup complete.');
}

module.exports = {
  ATTEMPTS,
  MIN_BYTES,
  BIN_URL,
  MODEL_BASE_URL,
  MODEL_SMALL_URL,
  adopt,
  countFiles,
  defaultTools,
  download,
  extract,
  findAll,
  findExe,
  flatten,
  listTree,
  looksLikeZip,
  main,
  prune,
};

if (require.main === module) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
