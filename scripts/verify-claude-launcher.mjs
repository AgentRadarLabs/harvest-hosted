#!/usr/bin/env node

// Prove the launcher by running it, not by trusting it.
//
// A unit test on argument building would pass while the shipped binary still opened the wrong
// directory, dropped the user's flags or swallowed a non-zero exit — the three things that actually
// matter to someone typing `harvest-hosted claude`. So this spawns the real bin entry with a fake
// `claude` first on PATH that records exactly what it received, and checks the recording.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binEntry = resolve(repositoryRoot, 'scripts', 'install.mjs');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A stand-in for Claude Code that writes down its argv, cwd and environment, then exits 7. */
function makeFakeClaude(directory, recordPath) {
  const script = [
    '#!/usr/bin/env node',
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
    '  argv: process.argv.slice(2),',
    '  cwd: process.cwd(),',
    '  env: process.env,',
    '}));',
    'process.exit(7);',
  ].join('\n');
  const scriptPath = resolve(directory, 'fake-claude.mjs');
  writeFileSync(scriptPath, script);
  const shim = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`;
  const shimPath = resolve(directory, 'claude');
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
}

const workspace = mkdtempSync(resolve(tmpdir(), 'harvest-launcher-'));
const fakeBin = resolve(workspace, 'bin');
const projectDirectory = resolve(workspace, 'a project with spaces');
const recordPath = resolve(workspace, 'record.json');
mkdirSync(fakeBin, { recursive: true });
mkdirSync(projectDirectory, { recursive: true });
makeFakeClaude(fakeBin, recordPath);

const userArgs = ['--model', 'opus', '-p', 'join the meeting', '--verbose'];
const run = spawnSync(process.execPath, [binEntry, 'claude', ...userArgs], {
  cwd: projectDirectory,
  env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  encoding: 'utf8',
});

check('launcher exits with Claude\'s own status', run.status === 7, `saw ${run.status}`);

const record = JSON.parse(readFileSync(recordPath, 'utf8'));

check(
  'channels scope is passed, once, ahead of user arguments',
  record.argv[0] === '--dangerously-load-development-channels'
    && record.argv[1] === 'server:harvest-hosted'
    && record.argv.filter((a) => a === '--dangerously-load-development-channels').length === 1,
  JSON.stringify(record.argv),
);

check(
  'user arguments survive in order and are not swallowed',
  JSON.stringify(record.argv.slice(2)) === JSON.stringify(userArgs),
  JSON.stringify(record.argv.slice(2)),
);

// macOS hands out /var but reports /private/var, so compare resolved paths rather than strings.
check(
  'Claude runs in the directory the user was in',
  realpathSync(record.cwd) === realpathSync(projectDirectory),
  `${record.cwd} != ${projectDirectory}`,
);

// The credential belongs in the MCP headers helper, never on a command line other processes can read.
const credentialish = /token|secret|api[-_]?key|credential|bearer/i;
check(
  'no credential is placed on the command line',
  !record.argv.some((argument) => credentialish.test(argument)),
  JSON.stringify(record.argv),
);

const injected = Object.keys(record.env).filter(
  (key) => /^HARVEST_/i.test(key) && !(key in process.env),
);
check('no Harvest environment is injected behind the user\'s back', injected.length === 0, injected.join(','));

// Passing the flag yourself must not double it up.
const secondRecord = resolve(workspace, 'record-2.json');
makeFakeClaude(fakeBin, secondRecord);
spawnSync(process.execPath, [
  binEntry, 'claude', '--dangerously-load-development-channels', 'server:harvest-hosted', '--resume',
], { cwd: projectDirectory, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } });
const repeated = JSON.parse(readFileSync(secondRecord, 'utf8'));
check(
  'an explicitly passed scope is not duplicated',
  repeated.argv.filter((a) => a === '--dangerously-load-development-channels').length === 1
    && repeated.argv[repeated.argv.length - 1] === '--resume',
  JSON.stringify(repeated.argv),
);

// The installer must remain exactly as strict as before the launcher existed.
const strictness = [
  { args: [], expected: 1 },
  { args: ['--runtime'], expected: 1 },
  { args: ['--runtime', 'bogus'], expected: 1 },
  { args: ['--runtime', 'codex', '--extra'], expected: 1 },
];
for (const attempt of strictness) {
  const result = spawnSync(process.execPath, [binEntry, ...attempt.args], { encoding: 'utf8' });
  check(
    `installer still fails closed: ${JSON.stringify(attempt.args)}`,
    result.status === attempt.expected,
    `saw ${result.status}`,
  );
}

// A missing Claude CLI has to say so plainly rather than look like a Harvest failure.
const emptyBin = resolve(workspace, 'empty-bin');
mkdirSync(emptyBin, { recursive: true });
const missing = spawnSync(process.execPath, [binEntry, 'claude'], {
  cwd: projectDirectory,
  env: { ...process.env, PATH: emptyBin },
  encoding: 'utf8',
});
check(
  'a missing Claude CLI is reported, not swallowed',
  missing.status === 127 && /not found in PATH/.test(missing.stderr || ''),
  `${missing.status} ${String(missing.stderr).trim()}`,
);

// The published package has to actually carry the launcher.
const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
check(
  'launcher is included in the published files list',
  manifest.files.includes('scripts/launch-claude.mjs'),
  manifest.files.join(','),
);

if (failures) {
  console.error(`\n${failures} launcher check(s) failed`);
  process.exit(1);
}
console.log('\nlauncher verified');
