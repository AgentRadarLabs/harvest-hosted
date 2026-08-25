#!/usr/bin/env node

// Clean-install smoke for the launcher, end to end, with nothing trusted.
//
// `npm test` proves the launcher from the repository. This proves the thing a user actually gets:
// pack the package, install that tarball into an empty project, put a stub `claude` on PATH, run
// the installed binary from a directory with a space in its name, and print exactly what the stub
// received. Every line of the transcript is evidence for one of the claims — the channels scope is
// present once and first, the user's arguments are intact and in order, the working directory is
// the caller's, no credential is on the command line, and the exit code is Claude's.
//
//   node scripts/smoke-launcher-install.mjs [transcript.log]

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const transcriptPath = process.argv[2] ? resolve(process.argv[2]) : null;

const lines = [];
function say(line) {
  console.log(line);
  lines.push(line);
  if (transcriptPath) appendFileSync(transcriptPath, line + '\n');
}

if (transcriptPath) writeFileSync(transcriptPath, '');

const tarball = execFileSync('npm', ['pack', '--silent'], { cwd: repositoryRoot, encoding: 'utf8' })
  .trim().split('\n').pop().trim();
say(`packed: ${tarball}`);

const workspace = mkdtempSync(resolve(tmpdir(), 'harvest-launcher-smoke-'));
const stubBin = resolve(workspace, 'bin');
const projectDirectory = resolve(workspace, 'a project with spaces');
mkdirSync(stubBin, { recursive: true });
mkdirSync(projectDirectory, { recursive: true });

writeFileSync(resolve(stubBin, 'claude'), [
  '#!/bin/sh',
  'echo "stub-claude argv: $*"',
  'echo "stub-claude cwd: $(pwd -P)"',
  'echo "stub-claude HARVEST_ vars: $(env | grep -c \'^HARVEST_\')"',
  'exit 42',
  '',
].join('\n'));
chmodSync(resolve(stubBin, 'claude'), 0o755);

execFileSync('npm', ['init', '-y'], { cwd: workspace, stdio: 'ignore' });
execFileSync('npm', ['install', '--silent', resolve(repositoryRoot, tarball)], { cwd: workspace, stdio: 'ignore' });
say(`installed into: ${workspace}`);

const userArgs = ['--model', 'opus', '-p', 'join the meeting', '--verbose'];
say(`invoked from: ${projectDirectory}`);
say(`command: node_modules/.bin/harvest-hosted claude ${userArgs.join(' ')}`);

const run = spawnSync(resolve(workspace, 'node_modules', '.bin', 'harvest-hosted'), ['claude', ...userArgs], {
  cwd: projectDirectory,
  env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` },
  encoding: 'utf8',
});
for (const line of String(run.stdout).trim().split('\n')) say(line);
say(`launcher exit code: ${run.status}`);

rmSync(resolve(repositoryRoot, tarball), { force: true });

const output = String(run.stdout);
const expectations = [
  ['channels scope present once, first', /argv: --dangerously-load-development-channels server:harvest-hosted /.test(output)
    && (output.match(/--dangerously-load-development-channels/g) || []).length === 1],
  ['user arguments intact and in order', output.includes(`server:harvest-hosted ${userArgs.join(' ')}`)],
  ['caller\'s working directory used', new RegExp(`cwd: .*a project with spaces`).test(output)],
  ['no credential on the command line', !/token|secret|api[-_]?key|bearer/i.test(output)],
  ['no HARVEST_ variables injected', /HARVEST_ vars: 0/.test(output)],
  ['Claude\'s exit code returned', run.status === 42],
];

let bad = 0;
for (const [name, ok] of expectations) {
  say(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) bad += 1;
}
say(bad === 0 ? 'install smoke: PASS' : `install smoke: FAIL (${bad})`);
process.exit(bad === 0 ? 0 : 1);
