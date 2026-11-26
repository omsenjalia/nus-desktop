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

function findExe(dir) {
  for (const name of ['whisper-cli.exe', 'main.exe']) {
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.toLowerCase() === name) return full;
      }
    }
  }
  return null;
}

// Keep only what whisper-cli needs; the zip ships benches, tests and demos.
function prune(dir) {
  const keep = /^(whisper-cli\.exe|main\.exe|.*\.dll)$/i;
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

// Expand-Archive first, because it is the platform's own unzipper. Then
// System32\tar.exe, which reads zip and ships with Windows 10 and later: two
// independent ways to fail means a bad download is distinguishable from a bad
// tool.
function extract(zipPath, dest) {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const attempts = [
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${dest}" -Force`]],
    [tar, ['-xf', zipPath, '-C', dest]],
  ];
  const failures = [];
  for (const [exe, args] of attempts) {
    try {
      execFileSync(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
      return;
    } catch (err) {
      const detail = String((err && (err.stderr || err.message)) || err).trim().split(/\r?\n/).slice(0, 4).join(' | ');
      failures.push(`${path.basename(exe)}: ${detail}`);
      console.log(`  ${path.basename(exe)} could not extract the zip: ${detail}`);
    }
  }
  throw new Error(`could not extract ${zipPath}: ${failures.join(' ; ')}`);
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
    extract(zipPath, vendorDir);
    fs.rmSync(zipPath, { force: true });
    const found = findExe(vendorDir);
    if (found) flatten(vendorDir, found);
  }
  prune(vendorDir);
  const exe = findExe(vendorDir);
  if (!exe) {
    throw new Error(`whisper binary not found after extract; ${path.relative(root, vendorDir)} contains: ${listTree(vendorDir)}`);
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
  download,
  extract,
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
