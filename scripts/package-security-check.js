// Checks a packed app.asar for the three things that have gone wrong before:
// something that must not ship is in it, something it needs is not, and a
// secret is inside a file that does ship.
//
//   node scripts/package-security-check.js [path/to/app.asar]
//
// The lists below are claims about the tree as much as about the archive, so
// they are exported and checked against the working tree by
// src/package-scan.test.js, where a stale entry shows up in a second instead of
// at the end of a 20-minute build.
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');

// The packed asar sits in a different place per target. An explicit path wins
// (CI passes the mac bundle); otherwise the first unpacked build found is used.
function candidatesFor(argv = process.argv) {
  if (argv[2]) return [path.resolve(argv[2])];
  return [
    path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar'),
    path.join(root, 'dist', 'mac-arm64', 'Nus.app', 'Contents', 'Resources', 'app.asar'),
    path.join(root, 'dist', 'mac', 'Nus.app', 'Contents', 'Resources', 'app.asar'),
  ];
}

// What must not be inside the archive. Anchored where it must be: a
// dependency's own AGENTS.md is its business, a copy at the top of the app is
// ours, and only the top of the app is a claim about what we shipped.
function isForbidden(entry) {
  return /^(?:docs|scripts|supabase)(?:\/|$)/i.test(entry)
    || /(?:^|\/)\.env(?:\.|$)/i.test(entry)
    || /^(?:src|renderer|companion)\/.*\.test\.js$/i.test(entry)
    || /^(?:deno\.lock|AGENTS\.md)$/i.test(entry);
}

// Every path here must exist in the packed app. It carried
// companion/renderer/strand.js after that renderer was deleted (the thread's
// engine replaced it), which failed every build at this scan — and only became
// visible once the earlier steps started passing.
const required = ['src/license.js', 'src/limits.js', 'src/main.js', 'src/ipc-origin.js', 'src/guide-input.js', 'renderer/index.html', 'companion/index.js', 'companion/preload.js', 'companion/renderer/index.html', 'companion/renderer/knot3d.js', 'companion/renderer/knot-engine.js', 'companion/renderer/knot-look.css', 'companion/src/guide/session.js', 'companion/src/guide/sensitive.js'];
// 2026-09-16: the Quiet Knot modules (selected-assistance, inspection-input,
// companion-context, quiet-knot.css) left with v0.2.6; knot-look.css replaced the sheet.
required.push('src/transcription-queue.js');

const patterns = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['stripe_secret', /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ['stripe_webhook_secret', /\bwhsec_[A-Za-z0-9]{16,}\b/g],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g],
  ['aws_access_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
];

function main(argv = process.argv) {
  const candidates = candidatesFor(argv);
  const archive = candidates.find((candidate) => fs.existsSync(candidate));

  if (!archive) {
    console.error(JSON.stringify({ ok: false, error: 'packaged_app_missing', looked: candidates.map((c) => path.relative(root, c)) }));
    return 1;
  }

  const entries = asar.listPackage(archive).map((entry) => entry.replace(/^[/\\]+/, '').replace(/\\/g, '/'));
  const forbiddenPaths = entries.filter(isForbidden);

  const missingPaths = required.filter((entry) => !entries.includes(entry));
  const ownedText = entries.filter((entry) =>
    /^(?:src|renderer|companion)\//.test(entry)
    && /\.(?:js|json|html|css|md)$/i.test(entry),
  );
  const secretFindings = [];
  const unreadablePaths = [];

  for (const entry of ownedText) {
    let source;
    try { source = asar.extractFile(archive, path.normalize(entry)).toString('utf8'); }
    catch { unreadablePaths.push(entry); continue; }
    for (const [kind, pattern] of patterns) {
      pattern.lastIndex = 0;
      const count = [...source.matchAll(pattern)].length;
      if (count) secretFindings.push({ file: entry, kind, count });
    }
  }

  const report = {
    ok: forbiddenPaths.length === 0 && missingPaths.length === 0 && secretFindings.length === 0 && unreadablePaths.length === 0,
    archive: path.relative(root, archive),
    packagedEntries: entries.length,
    ownedTextFilesScanned: ownedText.length - unreadablePaths.length,
    unreadablePaths,
    forbiddenPaths,
    missingPaths,
    secretFindings,
  };

  if (!report.ok) {
    console.error(JSON.stringify(report, null, 2));
    return 1;
  }
  console.log(JSON.stringify(report));
  return 0;
}

module.exports = { candidatesFor, isForbidden, main, patterns, required };

if (require.main === module) process.exit(main());
