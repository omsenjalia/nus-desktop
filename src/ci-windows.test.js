'use strict';
// The Windows build workflow, checked against the app it claims to build.
//
// A workflow is a second, unwritten copy of the build: it names an exe, an asar
// path and a set of artifacts, and none of those are checked by running it. If
// the builder renames the product, or the asar stops being at the path the scan
// reads, CI fails at 3am rather than here. These tests keep the two in step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const workflow = read('.github/workflows/build-windows.yml');
const builder = require('../electron-builder.config');

const lines = workflow.split('\n');
// The step body under a name, up to the next step.
function stepBody(name) {
  const at = lines.findIndex((l) => l.includes('name: ' + name));
  assert.ok(at > 0, 'the step exists: ' + name);
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^ {6}- /.test(lines[i]) || /^ {6}(uses|with):/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

test('the workflow triggers by hand only, and never publishes a release', () => {
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/, 'manual trigger only');
  assert.doesNotMatch(workflow, /^\s{2}(push|pull_request|schedule):/m, 'no automatic runs');
  assert.match(workflow, /--publish never/, 'the build does not publish');
  assert.doesNotMatch(workflow, /gh release create/, 'attaching a release stays a human command');
});

test('the exe name in the smoke step is the name the builder produces', () => {
  const body = stepBody('Smoke the unpacked app');
  const named = [...body.matchAll(/dist\\win-unpacked\\([A-Za-z0-9 ._-]+\.exe)/g)].map((m) => m[1]);
  assert.ok(named.length > 0, 'the step runs an exe');
  for (const exe of named) {
    assert.equal(exe, builder.productName + '.exe', 'electron-builder names the unpacked exe after productName');
  }
});

test('the asar the scan reads is at the path electron-builder writes', () => {
  const body = stepBody('Scan the packed asar');
  assert.match(body, /dist\/win-unpacked\/resources\/app\.asar\b/);
  // An asar exists unless the build is told not to make one.
  assert.notEqual(builder.asar, false, 'the build must produce an asar for the scan to mean anything');
});

test('every artifact the workflow uploads has a name the builder is configured to produce', () => {
  const block = workflow.slice(workflow.indexOf('name: jarvis-windows') - 400);
  const uploaded = [...block.matchAll(/^\s+dist\/(\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(uploaded.length >= 3, 'it uploads the installers: ' + uploaded.join(', '));

  const nsisName = builder.win.artifactName.replace('${ext}', 'exe');
  const portableName = builder.portable.artifactName.replace('${ext}', 'exe');
  for (const file of uploaded) {
    const expected = [nsisName, portableName, nsisName + '.blockmap', 'latest.yml'];
    assert.ok(expected.includes(file), file + ' is produced by electron-builder; known: ' + expected.join(', '));
  }
  // And the two installers themselves are both uploaded: a run that shipped
  // only one of them would be a silent change of what a download is.
  assert.ok(uploaded.includes(nsisName), 'the installer is uploaded');
  assert.ok(uploaded.includes(portableName), 'the portable exe is uploaded');
});

test('the build actually launches what it ships', () => {
  const body = stepBody('Smoke the unpacked app');
  assert.match(body, /--smoke/, 'it runs the app with --smoke');
  assert.match(body, /smoke ok/, 'and fails when the app does not report it');
  assert.match(body, /NUS_SMOKE_DATA_DIR/, 'with an isolated profile, never the runner real one');
});

test('the voice model is fetched, and against the same pin the app checks', () => {
  // vendor/ is gitignored: nothing in a clean checkout has the model, and
  // `npm run dist` starts with a script that needs it.
  assert.match(read('.gitignore'), /^vendor\/$/m, 'vendor is not in the tree');

  // The pin lives in the workflow-level env, because the model cache, the
  // archive cache and the lines cache all key on it. It must be the whole hash:
  // a prefix would let a different model through.
  const declared = workflow.match(/^ {2}FABLE_PIN: ([0-9a-f]+)$/m);
  assert.ok(declared, 'FABLE_PIN is declared once, at the top');
  assert.equal(declared[1].length, 64, 'a full SHA-256, not a prefix');

  const voice = read('companion/src/voice/index.js');
  assert.ok(voice.includes(declared[1]), 'the workflow pin is the one in companion/src/voice/index.js');

  const body = stepBody('Fetch the Fable voice model for the pre-built lines');
  assert.match(body, /Get-FileHash -Algorithm SHA256/, 'it checks the hash');
  assert.match(body, /\$env:FABLE_PIN/, 'against the declared pin');
  assert.match(body, /-ne \$want/, 'and fails on a mismatch rather than carrying on');
  // A cache that goes bad must not poison every later run.
  assert.match(body, /Remove-Item \$archive -Force/, 'a bad cached archive is removed, not kept');
});

test('every cache is keyed on something that changes when its contents change', () => {
  // A cache that outlives its contents serves stale files forever. Each one is
  // keyed on the pin or the sources that decide what is inside it.
  const caches = [...workflow.matchAll(/- name: Cache ([^\n]+)\n([\s\S]*?)(?=\n {6}- |\n {6}uses:|$)/g)];
  assert.equal(caches.length, 4, 'four caches: electron, whisper, voice lines, Fable archive');

  const key = (name) => {
    const c = caches.find((m) => m[1].toLowerCase().includes(name.toLowerCase()));
    assert.ok(c, 'the ' + name + ' cache exists');
    const k = c[2].match(/^\s+key: (.+)$/m);
    assert.ok(k, 'the ' + name + ' cache has a key');
    return k[1];
  };
  assert.match(key('Electron'), /hashFiles\('package-lock\.json'\)/, 'npm lock changes');
  assert.match(key('whisper'), /whisper-b4938/, 'the pinned tag');
  assert.match(key('voice lines'), /FABLE_PIN/, 'the model pin');
  assert.match(key('voice lines'), /hashFiles\(/, 'and the sources that define the lines');
  assert.match(key('voice archive'), /FABLE_PIN/, 'the model pin');

  // No cache is shared across operating systems: a Windows electron build in a
  // Linux cache is a download that silently does not happen.
  for (const m of caches) assert.match(m[2], /runner\.os|hashFiles|b4938|FABLE_PIN/);
});

test('a cache hit never skips the hash check', () => {
  // The point of caching the archive is to save the download, not the
  // verification. If a restored archive were trusted, the pin would only guard
  // the first run.
  const body = stepBody('Fetch the Fable voice model for the pre-built lines');
  const hashAt = body.indexOf('Get-FileHash');
  const unpackAt = body.indexOf('-xjf');
  assert.ok(hashAt > 0 && unpackAt > hashAt, 'the hash is checked before anything is unpacked');
  assert.match(body, /restored from cache; verifying it anyway/, 'and the log says so');
});

test('the workflow asks for no server credentials', () => {
  // No accounts in this build, so no Supabase project to configure. The two
  // remaining integrations are optional and may be empty.
  assert.doesNotMatch(workflow, /NUS_SUPABASE_URL:\s*\$\{\{\s*secrets/, 'no Supabase secret is requested');
  assert.doesNotMatch(workflow, /NUS_SUPABASE_ANON_KEY:\s*\$\{\{\s*secrets/);
  assert.match(workflow, /node scripts\/write-config\.js/, 'config.js is still rendered, or startup fails');
});

test('the config step cannot fail on an unset optional secret', () => {
  // The first run of this workflow died here: write-config treats an empty
  // value as missing, and setting the variables to '' in PowerShell does not
  // satisfy it. The step now asks for an empty-tolerant config by flag.
  const body = stepBody('Write src/config.js');
  assert.match(body, /write-config\.js --allow-empty/, 'the step passes --allow-empty');
  assert.doesNotMatch(body, /Set-Item "env:/, 'no PowerShell dance is needed to fake emptiness');
});

test('the voice-line guard runs after the lines are built, not before', () => {
  // `make-voice-lines --check` exits 1 when the lines are missing, and they are
  // made by `npm run dist` itself. Putting the check first made it a guard that
  // fails on every clean checkout, which is a guard that means nothing.
  const at = (needle) => workflow.split('\n').findIndex((l) => l.includes(needle));
  const check = at('make-voice-lines.js --check');
  const build = at('npm run dist -- --publish never');
  assert.ok(build > 0, 'the build step exists');
  assert.ok(check > build, 'the check comes after the build');
});

test('an unset config value is empty, not the word undefined', () => {
  // The generated file is read by truthiness tests, and the string "undefined"
  // is truthy. Rendering an absent variable with JSON.stringify(String(undefined))
  // produced exactly that; this pins the fix.
  const src = read('scripts/write-config.js');
  assert.match(src, /const v = \(name\) => JSON\.stringify\(String\(process\.env\[name\] \|\| ''\)\.trim\(\)\)/);
  assert.doesNotMatch(src, /String\(process\.env\[name\]\)\.trim\(\)/, 'no bare String(undefined)');
});

test('the generated config does not let an empty env var win at run time', () => {
  // `process.env.X || 'value'` meant a var set to '' in CI overrode the value
  // the generator was told to write, which is how "configured" could become
  // truthy-but-empty.
  const gen = read('scripts/write-config.js');
  const body = gen.slice(gen.indexOf('const source = `'), gen.search(/`;\s*\n\s*function isSupabaseConfigured/));
  assert.doesNotMatch(body, /process\.env\.NUS_/, 'the written file carries values, not env reads');
});

test('what the code reads from resources is what the builder puts there', () => {
  // The app reads its voice and its pre-made lines from process.resourcesPath.
  // extraResources is the only thing that puts them there, and a missing entry
  // is invisible: the app runs, and simply speaks in the wrong voice.
  const targets = (builder.win.extraResources || []).map((r) => r.to);
  for (const wanted of ['whisper', 'win', 'voice', 'voice-lines']) {
    assert.ok(targets.includes(wanted), 'win.extraResources copies to ' + wanted + '; has: ' + targets.join(', '));
  }
  const voice = read('companion/src/voice/index.js');
  assert.match(voice, /path\.join\(process\.resourcesPath, 'voice'\)/, 'voice/index.js reads resources/voice');
  const lineFile = read('companion/src/voice/lines.js');
  assert.match(lineFile, /path\.join\(resourcesPath, 'voice-lines'\)/, 'lines.js reads resources/voice-lines');
});

test('the dist script builds the lines before it packs them', () => {
  // vendor/voice-lines is made, not committed, so a dist that skips the script
  // packs nothing and the extraResources glob quietly matches no files.
  const pkg = require('../package.json');
  assert.match(pkg.scripts.dist, /^node scripts\/make-voice-lines\.js/);
  assert.match(pkg.scripts.dist, /electron-builder --win/);
});

test('a failed whisper fetch says why, in the one place that can be read', () => {
  // The step fetches a GitHub release and a Hugging Face model, and when it
  // failed the run log lived in blob storage while the annotation said only
  // "exit code 1". It now writes the tail of its output into an annotation and
  // the whole log into an artifact — the same deal the Test step made.
  const body = stepBody('Fetch the whisper binary the Windows build bundles');
  assert.match(body, /npm run setup:voice/, 'it still runs the script');
  assert.match(body, /\$LASTEXITCODE/, 'it reads the exit code rather than trusting the pipe');
  assert.match(body, /::error title=setup:voice failed::/, 'the reason is an annotation');
  assert.match(body, /-Tail 40/, 'the end of the output, which is where the error is');
  assert.match(body, /exit \$code/, 'and the step still fails');
  assert.match(workflow, /name: setup-voice-output/, 'with the full log attached as an artifact');
});

test('a failed Fable fetch says why too, and how big the file that failed was', () => {
  // The step downloads 334 MB and then refuses it, and the run log is
  // unreadable from outside. The annotation carries the exception and the size
  // on disk, which is the difference between "the network truncated it" and
  // "the pin is stale" — the two causes that produce the same hash mismatch.
  const body = stepBody('Fetch the Fable voice model for the pre-built lines');
  assert.match(body, /::error title=Fable voice archive failed::/, 'the reason is an annotation');
  assert.match(body, /Get-Item \$archive\)\.Length/, 'the size of what landed is part of it');
  assert.match(body, /exit 1/, 'and the step still fails');

  // The expected size is not decoration: it is the release asset's size, and it
  // is the same number companion/src/voice/index.js records for the model the
  // app will accept.
  const declared = Number(workflow.match(/^ {2}FABLE_BYTES: (\d+)$/m)[1]);
  const voice = read('companion/src/voice/index.js');
  const asset = voice.match(/kokoro-multi-lang-v1_0\.tar\.bz2[^}]*?bytes: (\d+)/);
  assert.ok(asset, 'the model declares the size it expects');
  assert.equal(declared, Number(asset[1]), 'the workflow checks the size the app checks');
});

test('the voice guard looks where the app looks, inside the archive folder', () => {
  // The archive keeps its top-level folder, and the app wants it that way:
  // modelDir() is resources/voice/<folder> and hasModel() asks that folder for
  // voices.bin and a .onnx. A guard that checked vendor/voice/voices.bin failed
  // a complete, correct 334 MB download, because the files were one level down
  // in the place the app actually reads.
  const voice = read('companion/src/voice/index.js');
  const folder = workflow.match(/^ {2}FABLE_FOLDER: (\S+)$/m);
  assert.ok(folder, 'the folder is named once, at the top');
  const declared = voice.match(/kokoro-multi-lang-v1_0\.tar\.bz2[^}]*?folder: '([^']+)'/);
  assert.ok(declared, 'the model declares its folder');
  assert.equal(folder[1], declared[1], 'the workflow extracts to the folder the app reads');

  const body = stepBody('Fetch the Fable voice model for the pre-built lines');
  assert.match(body, /Join-Path \$root \$env:FABLE_FOLDER/, 'the guard is inside that folder');
  assert.match(body, /voices\.bin/, 'and asks for the file hasModel() asks for');
  assert.match(body, /model\.onnx/, 'and the second one');
  assert.doesNotMatch(body, /Test-Path \(Join-Path \$root 'voices\.bin'\)/, 'not one level up');
});

test('the voice addon the workers require is a dependency, and on the 1.x API', () => {
  // The build died in one second at "Build installer and portable exe": the
  // first thing `npm run dist` does is make the fixed voice lines, and that
  // spawns companion/src/voice/engine-worker.js, which requires
  // sherpa-onnx-node. Nothing installed it — it was named in asarUnpack and in
  // THIRD-PARTY.md and nowhere in package.json — so on a clean checkout the
  // worker exited before it said a word.
  const pkg = require('../package.json');
  const dep = pkg.dependencies['sherpa-onnx-node'];
  assert.ok(dep, 'a clean npm ci must install it: the packaged app needs it too');
  assert.equal(pkg.devDependencies['sherpa-onnx-node'], undefined, 'it ships, so it is not a devDependency');
  // 2.0 rewrote the package (OfflineTts became non-streaming-tts.js); the two
  // workers use the 1.x classes and were not ported to the new spelling.
  assert.match(dep, /^[~^]?1\./, 'the addon is pinned to the API the workers call');
  for (const worker of ['companion/src/voice/engine-worker.js', 'companion/src/voice/parakeet-worker.js']) {
    assert.match(read(worker), /require\('sherpa-onnx-node'\)/, worker + ' is the reason');
  }
});
