#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowedTopLevel = new Set([
  '.git', '.gitignore', 'CLAUDE.md', 'LICENSE', 'README.md', 'SECURITY.md', 'scripts',
  // Agent Plugins 1.0.0 layout: the manifest, the MCP servers, and the skill in its own directory.
  'plugin.json', 'mcp.json', 'skills',
  // Transcripts a reviewer reads instead of rerunning. Repository-only: the published tarball is
  // an explicit file list, and the packed-contents assertion below fails if anything from here
  // ever reaches npm.
  'evidence',
  'node_modules', 'package-lock.json', 'package.json',
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
const skill = readFileSync(resolve(root, 'skills', 'harvest', 'SKILL.md'), 'utf8');
const license = readFileSync(resolve(root, 'LICENSE'), 'utf8');
const registrationHelper = readFileSync(resolve(root, 'scripts', 'register.mjs'), 'utf8');
const mcpHeadersHelper = readFileSync(resolve(root, 'scripts', 'mcp-headers.mjs'), 'utf8');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const cloneInstall = 'git clone --depth 1 https://github.com/AgentRadarLabs/harvest-hosted.git';
if (!readme.includes(cloneInstall)) failures.push('README canonical clone install missing');
if (/npx\s+--yes\s+harvest-hosted@/i.test(readme)) {
  failures.push('README promotes an unpublished npm package');
}
if (/github\.com\/f1scord\/harvest-hosted/i.test(`${readme}\n${packageJson.repository?.url || ''}`)) {
  failures.push('repository metadata still points at the pre-transfer owner');
}
if (!/^---\r?\nname: harvest\r?\n/.test(skill)) failures.push('SKILL.md frontmatter invalid');
for (const [name, source] of [['README.md', readme], ['SKILL.md', skill], ['scripts/register.mjs', registrationHelper]]) {
  if (!source.includes('https://tryharvest.ai')) failures.push(`${name} first-party production URL missing`);
  if (/sslip\.io|84\.32\.83\.100|gateway\.tryharvest\.ai|mcp\.tryharvest\.ai/.test(source)) {
    failures.push(`${name} contains a legacy or wildcard-IP endpoint`);
  }
}
if (!registrationHelper.includes("action === 'import-env'")) {
  failures.push('registration helper must support owner-provisioned environment credentials');
}
if (!registrationHelper.includes("createHash('sha256').update(token)")) {
  failures.push('registration helper must derive the non-secret fingerprint from the credential hash');
}
if (!registrationHelper.includes("writeConfig({ ...readConfig(), api_url: apiUrl, token })")) {
  failures.push('registration helper must persist the validated environment credential');
}
if (/without asking (?:me|the user) anything/i.test(`${readme}\n${skill}`)) {
  failures.push('onboarding contains concealment-style language');
}
if (readme.includes('Public email-code registration is not enabled yet')) failures.push('README still says registration is unavailable');
if (skill.includes('public registration is not live')) failures.push('SKILL still says registration is unavailable');
if (!skill.includes('async=true') || !skill.includes('get_join_status')) {
  failures.push('SKILL must use async join lifecycle for remote MCP clients');
}
if (!skill.includes('replay_meeting_events') || !skill.includes('latest_event_id')) {
  failures.push('SKILL must explain bounded event replay after an agent reconnect');
}
if (!license.includes('All rights reserved.')) failures.push('proprietary license marker missing');
if (packageJson.name !== 'harvest-hosted' || !/^0\.1\.[1-9]\d*$/.test(packageJson.version)) {
  failures.push('npm identity mismatch');
}
if (packageJson.license !== 'UNLICENSED') failures.push('npm package must remain proprietary');

// Agent Plugins 1.0.0. A schema violation makes a conformant client reject the whole plugin, and
// the two manifests are small enough to check by hand here rather than fetching a validator.
const pluginManifest = JSON.parse(readFileSync(resolve(root, 'plugin.json'), 'utf8'));
const mcpManifest = JSON.parse(readFileSync(resolve(root, 'mcp.json'), 'utf8'));
const allowedManifestKeys = new Set([
  '$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license',
  'keywords', 'extensions',
]);
if (pluginManifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') {
  failures.push('plugin.json declares a different Agent Plugins version');
}
if (mcpManifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json') {
  failures.push('mcp.json declares a different Agent Plugins version');
}
if (!/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(pluginManifest.name || '')) {
  failures.push('plugin name breaks the Agent Plugins naming rule');
}
for (const key of Object.keys(pluginManifest)) {
  if (!allowedManifestKeys.has(key)) failures.push(`plugin.json has an unspecified field: ${key}`);
}
// One version, two files: a plugin published as 0.1.2 must be the tarball called 0.1.2.
if (pluginManifest.version !== packageJson.version) {
  failures.push(`plugin.json version ${pluginManifest.version} != package ${packageJson.version}`);
}
const bridgeArgument = '${PLUGIN_ROOT}/scripts/channel-bridge.bundle.mjs';
const pluginServer = mcpManifest.mcpServers?.['harvest-hosted'];
if (pluginServer?.type !== 'stdio' || !pluginServer.args?.includes(bridgeArgument)) {
  failures.push('mcp.json must start the packaged bridge from ${PLUGIN_ROOT}');
}
if (!pluginServer?.args?.includes('https://tryharvest.ai/mcp')) {
  failures.push('mcp.json must point at the first-party production endpoint');
}
// Placeholders are not expanded in headers, so a header here could only be a literal credential.
for (const [name, server] of Object.entries(mcpManifest.mcpServers || {})) {
  if (server?.headers) failures.push(`mcp.json server ${name} carries literal headers`);
}

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
  'LICENSE', 'README.md', 'SECURITY.md', 'package.json', 'scripts/install.mjs', 'scripts/launch-claude.mjs',
  'plugin.json', 'mcp.json', 'skills/harvest/SKILL.md',
  'scripts/channel-bridge.bundle.mjs', 'scripts/mcp-headers.mjs',
  'scripts/register.mjs',
].sort();
if (packedFiles.some((file) => file === 'evidence' || file.startsWith('evidence/'))) {
  failures.push('evidence must never be published to npm');
}
if (JSON.stringify(packedFiles) !== JSON.stringify(expectedPackedFiles)) {
  failures.push(`npm package allowlist mismatch: ${packedFiles.join(',')}`);
}

const tempHome = mkdtempSync(resolve(tmpdir(), 'harvest-skill-verify-'));
try {
  const fakeBin = resolve(tempHome, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  installPassiveFakeCodex(fakeBin);
  const env = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    CODEX_HOME: resolve(tempHome, '.codex'),
    PATH: `${fakeBin}${delimiter}${process.env.PATH || ''}`,
  };
  execFileSync(process.execPath, [resolve(root, 'scripts', 'install.mjs'), '--runtime', 'codex'], {
    env,
    stdio: 'pipe',
  });
  const installed = readFileSync(resolve(tempHome, '.codex', 'skills', 'harvest', 'SKILL.md'), 'utf8');
  if (installed !== skill) failures.push('isolated Codex install differs from the packaged SKILL.md');
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
  const installedBridge = readFileSync(
    resolve(tempHome, '.codex', 'skills', 'harvest', 'channel-bridge.mjs'),
    'utf8',
  );
  if (installedBridge !== readFileSync(resolve(root, 'scripts', 'channel-bridge.bundle.mjs'), 'utf8')) {
    failures.push('isolated Codex channel bridge differs from source');
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
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolute = resolve(path, entry.name);
    if (entry.isDirectory()) output.push(...walk(absolute));
    else if (entry.isFile()) output.push(absolute);
    else failures.push(`unsupported filesystem entry: ${basename(absolute)}`);
  }
  return output;
}

function installPassiveFakeCodex(directory) {
  const script = resolve(directory, 'fake-codex.cjs');
  writeFileSync(script, [
    'const args = process.argv.slice(2);',
    "if (args[0] === 'mcp' && args[1] === 'get') {",
    "  console.error(\"Error: No MCP server named 'harvest-hosted' found.\");",
    '  process.exit(1);',
    '}',
    "if (args[0] === 'mcp' && args[1] === 'add') process.exit(0);",
    'process.exit(2);',
  ].join('\n'));
  if (process.platform === 'win32') {
    writeFileSync(resolve(directory, 'codex.cmd'), `@"${process.execPath}" "%~dp0fake-codex.cjs" %*\r\n`);
    return;
  }
  const executable = resolve(directory, 'codex');
  writeFileSync(executable, `#!${process.execPath}\nrequire('./fake-codex.cjs');\n`);
  chmodSync(executable, 0o755);
}
