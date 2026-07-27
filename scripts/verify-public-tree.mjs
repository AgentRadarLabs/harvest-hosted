#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowedTopLevel = new Set([
  '.git', '.gitignore', 'LICENSE', 'README.md', 'SECURITY.md', 'SKILL.md', 'scripts',
  'package.json',
]);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\b(?:api[_-]?key|secret|token)\s*[:=]\s*["'][^"']{8,}["']/i,
];

const failures = [];
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!allowedTopLevel.has(entry.name)) failures.push(`unexpected top-level entry: ${entry.name}`);
}

const files = walk(root).filter((path) => !relative(root, path).split(/[\\/]/).includes('.git'));
for (const path of files) {
  const rel = relative(root, path).replaceAll('\\', '/');
  const content = readFileSync(path, 'utf8');
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) failures.push(`possible secret in ${rel}`);
  }
}

const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const skill = readFileSync(resolve(root, 'SKILL.md'), 'utf8');
const license = readFileSync(resolve(root, 'LICENSE'), 'utf8');
const registrationHelper = readFileSync(resolve(root, 'scripts', 'register.mjs'), 'utf8');
const mcpHeadersHelper = readFileSync(resolve(root, 'scripts', 'mcp-headers.mjs'), 'utf8');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
if (!readme.includes('https://github.com/f1scord/harvest-hosted.git')) failures.push('README clone URL missing');
if (!/^---\r?\nname: harvest\r?\n/.test(skill)) failures.push('SKILL.md frontmatter invalid');
for (const [name, source] of [['README.md', readme], ['SKILL.md', skill], ['scripts/register.mjs', registrationHelper]]) {
  if (!source.includes('https://gateway.84.32.83.100.sslip.io')) failures.push(`${name} production registration URL missing`);
}
if (readme.includes('Public email-code registration is not enabled yet')) failures.push('README still says registration is unavailable');
if (skill.includes('public registration is not live')) failures.push('SKILL still says registration is unavailable');
if (!skill.includes('async=true') || !skill.includes('get_join_status')) {
  failures.push('SKILL must use async join lifecycle for remote MCP clients');
}
if (!license.includes('All rights reserved.')) failures.push('proprietary license marker missing');
if (packageJson.name !== 'harvest-hosted' || packageJson.version !== '0.1.0') failures.push('npm identity mismatch');
if (packageJson.license !== 'UNLICENSED') failures.push('npm package must remain proprietary');

const npmCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const npmArgs = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm pack --dry-run --json']
  : ['pack', '--dry-run', '--json'];
const packResult = JSON.parse(execFileSync(npmCommand, npmArgs, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}));
const packedFiles = packResult[0]?.files?.map((file) => file.path).sort() || [];
const expectedPackedFiles = [
  'LICENSE', 'README.md', 'SECURITY.md', 'SKILL.md', 'package.json', 'scripts/install.mjs',
  'scripts/mcp-headers.mjs', 'scripts/register.mjs',
].sort();
if (JSON.stringify(packedFiles) !== JSON.stringify(expectedPackedFiles)) {
  failures.push(`npm package allowlist mismatch: ${packedFiles.join(',')}`);
}

const tempHome = mkdtempSync(resolve(tmpdir(), 'harvest-skill-verify-'));
try {
  const env = { ...process.env, HOME: tempHome, USERPROFILE: tempHome, CODEX_HOME: resolve(tempHome, '.codex') };
  execFileSync(process.execPath, [resolve(root, 'scripts', 'install.mjs'), '--runtime', 'codex'], {
    env,
    stdio: 'pipe',
  });
  const installed = readFileSync(resolve(tempHome, '.codex', 'skills', 'harvest', 'SKILL.md'), 'utf8');
  if (installed !== skill) failures.push('isolated Codex install differs from root SKILL.md');
  const installedRegistration = readFileSync(
    resolve(tempHome, '.codex', 'skills', 'harvest', 'register.mjs'),
    'utf8',
  );
  if (installedRegistration !== readFileSync(resolve(root, 'scripts', 'register.mjs'), 'utf8')) {
    failures.push('isolated Codex registration helper differs from source');
  }
  const installedHeaders = readFileSync(
    resolve(tempHome, '.codex', 'skills', 'harvest', 'mcp-headers.mjs'),
    'utf8',
  );
  if (installedHeaders !== mcpHeadersHelper) {
    failures.push('isolated Codex MCP headers helper differs from source');
  }
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log(`PASS public-tree files=${files.length} npm_files=${packedFiles.length} possible_secrets=0 isolated_install=green`);

function walk(path) {
  const output = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const absolute = resolve(path, entry.name);
    if (entry.isDirectory()) output.push(...walk(absolute));
    else if (entry.isFile()) output.push(absolute);
    else failures.push(`unsupported filesystem entry: ${basename(absolute)}`);
  }
  return output;
}
