#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(repositoryRoot, 'skills', 'harvest', 'SKILL.md');
const registrationSourcePath = resolve(repositoryRoot, 'scripts', 'register.mjs');
const mcpHeadersSourcePath = resolve(repositoryRoot, 'scripts', 'mcp-headers.mjs');
const bridgeSourcePath = resolve(repositoryRoot, 'scripts', 'channel-bridge.bundle.mjs');
// Exact SHA-256 values from the published 0.2.5/0.2.6/0.2.7 tarballs, not Git history.
const KNOWN_INSTALLED_SHA256 = {
  'SKILL.md': ['67a394a5310d21357219c1a246f37af6528618c68eca2b33ed16d6efb919d354'],
  'register.mjs': ['da59b75822b96eed4d6195e38d6a0b927c3cde063e354ca7630d85f1597d3bf5'],
  'mcp-headers.mjs': ['a043ea14ad3f1cfa3e4ccae8ccc28f2fec8b7d15ae9b878fdc3ec98203657751'],
  'channel-bridge.mjs': [
    '7974ad5893df1bf55d94715d921e3b61834bf2dedbb644cf83d4123c159706d5',
    '297702a654f7deba15584566ae770885bf915eb8803a495588187949fb8a5048',
    'fe911c7bd91434e807c9b459101a63888feb938716658d7e8417267a43f79d1b',
  ],
};
const args = process.argv.slice(2);

// `harvest-hosted claude ...` is a launcher, not an install: it starts Claude Code in this
// directory with the Harvest Channels scope already on, which the README calls the connection
// rather than an optional extra. It is dispatched before any installer argument checking so a user
// argument can never be read as an installer flag, and the installer stays exactly as strict.
if (args[0] === 'claude') {
  const { runClaude } = await import('./launch-claude.mjs');
  runClaude(args.slice(1));
} else {

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/install.mjs --runtime <codex|claude-code|cursor|gemini|windsurf|copilot|junie|openclaw> [--upgrade]');
  console.log('       harvest-hosted claude [claude arguments]');
  process.exit(0);
}

const runtimeIndex = args.indexOf('--runtime');
const runtime = runtimeIndex >= 0 ? args[runtimeIndex + 1] : '';
const upgrade = args[2] === '--upgrade';
if (!runtime || args.length !== (upgrade ? 3 : 2) || runtimeIndex !== 0) {
  fail('expected --runtime <codex|claude-code|cursor|gemini|windsurf|copilot|junie|openclaw> [--upgrade]');
}

const targetDirectories = {
  codex: resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'skills', 'harvest'),
  'claude-code': resolve(process.env.CLAUDE_CONFIG_DIR || resolve(homedir(), '.claude'), 'skills', 'harvest'),
  cursor: resolve(homedir(), '.cursor', 'skills', 'harvest'),
  gemini: resolve(homedir(), '.gemini', 'skills', 'harvest'),
  windsurf: resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config'), 'devin', 'skills', 'harvest'),
  copilot: resolve(process.env.COPILOT_HOME || resolve(homedir(), '.copilot'), 'skills', 'harvest'),
  junie: resolve(homedir(), '.junie', 'skills', 'harvest'),
  openclaw: resolve(process.env.OPENCLAW_STATE_DIR || resolve(homedir(), '.openclaw'), 'skills', 'harvest'),
};
const targetDirectory = targetDirectories[runtime];
if (!targetDirectory) fail(`unsupported runtime: ${runtime}`);

const source = readFileSync(sourcePath, 'utf8');
const registrationSource = readFileSync(registrationSourcePath, 'utf8');
const mcpHeadersSource = readFileSync(mcpHeadersSourcePath, 'utf8');
const bridgeSource = readFileSync(bridgeSourcePath, 'utf8');
const targetPath = resolve(targetDirectory, 'SKILL.md');
const registrationTargetPath = resolve(targetDirectory, 'register.mjs');
const mcpHeadersTargetPath = resolve(targetDirectory, 'mcp-headers.mjs');
const bridgeTargetPath = resolve(targetDirectory, 'channel-bridge.mjs');
installFiles(targetDirectory, [
  [targetPath, source],
  [registrationTargetPath, registrationSource],
  [mcpHeadersTargetPath, mcpHeadersSource],
  [bridgeTargetPath, bridgeSource],
], upgrade);
if (runtime === 'claude-code') configureClaudeMcp(bridgeTargetPath);
if (runtime === 'codex') configureCodexMcp(bridgeTargetPath);
const jsonConfigPaths = {
  cursor: resolve(homedir(), '.cursor', 'mcp.json'),
  gemini: resolve(homedir(), '.gemini', 'settings.json'),
  windsurf: resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config'), 'devin', 'mcp_config.json'),
  copilot: resolve(process.env.COPILOT_HOME || resolve(homedir(), '.copilot'), 'mcp-config.json'),
  junie: resolve(homedir(), '.junie', 'mcp', 'mcp.json'),
};
if (jsonConfigPaths[runtime]) configureJsonMcp(jsonConfigPaths[runtime], bridgeTargetPath, runtime);
if (runtime === 'openclaw') {
  // OpenClaw owns JSON5 config. Use its native registry instead of rewriting it as JSON.
  console.log('Skill installed. Register MCP once with `openclaw mcp add` as shown in README; this installer does not modify OpenClaw JSON5.');
}
console.log(`Harvest skill installed for ${runtime}: ${targetPath}`);

}

function configureClaudeMcp(bridgePath) {
  const expected = {
    command: process.execPath,
    args: [bridgePath, '--url', 'https://tryharvest.ai/mcp'],
  };
  const server = JSON.stringify(expected);
  const command = process.platform === 'win32' ? 'claude.cmd' : 'claude';

  // Running the installer twice is a normal thing for a person to do — re-reading the setup
  // instructions, re-pasting the prompt, or just being unsure the first run worked. Before
  // this check the second run died with "MCP server harvest-hosted already exists" and a
  // non-zero exit, which reads as a broken product rather than "nothing to do".
  const existing = readClaudeMcpEntry();
  if (existing) {
    if (mcpEntryMatches(existing, expected)) {
      console.log('Harvest MCP already configured for Claude Code; nothing to change.');
      return;
    }
    // Someone else's entry, or ours pointing somewhere stale. Overwriting silently would be
    // worse than saying so: the recovery is one command and it is theirs to run.
    fail(
      'a different MCP server named harvest-hosted is already configured. '
      + 'Remove it with `claude mcp remove --scope user harvest-hosted`, then run this installer again',
    );
  }

  const commandArgs = ['mcp', 'add-json', '--scope', 'user', 'harvest-hosted', server];
  try {
    const options = { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] };
    if (process.platform === 'win32') {
      execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command, ...commandArgs], options);
    } else {
      execFileSync(command, commandArgs, options);
    }
  } catch (error) {
    const detail = error?.code === 'ENOENT'
      ? 'Claude Code CLI was not found in PATH'
      : String(error?.stderr || error?.message || 'unknown Claude CLI error').trim();
    fail(`could not configure Harvest MCP: ${detail}`);
  }
}

function configureCodexMcp(bridgePath) {
  const expected = {
    command: process.execPath,
    args: [bridgePath, '--url', 'https://tryharvest.ai/mcp'],
  };
  const current = runRuntimeCli('codex', ['mcp', 'get', 'harvest-hosted', '--json']);
  if (current.ok) {
    let configured;
    try {
      configured = JSON.parse(current.stdout);
    } catch {
      fail('could not parse existing Codex Harvest MCP configuration');
    }
    if (
      configured?.transport?.type !== 'stdio'
      || configured.transport.command !== expected.command
      || JSON.stringify(configured.transport.args) !== JSON.stringify(expected.args)
    ) {
      fail('existing Codex MCP server differs: harvest-hosted');
    }
    return;
  }
  if (!`${current.stdout}\n${current.stderr}`.includes("No MCP server named 'harvest-hosted' found")) {
    fail(`could not inspect Codex MCP: ${current.stderr || current.stdout || 'unknown Codex CLI error'}`);
  }
  const added = runRuntimeCli('codex', [
    'mcp', 'add', 'harvest-hosted', '--',
    expected.command, ...expected.args,
  ]);
  if (!added.ok) fail(`could not configure Codex MCP: ${added.stderr || added.stdout}`);
}

function runRuntimeCli(name, commandArgs) {
  const command = process.platform === 'win32' ? `${name}.cmd` : name;
  const options = {
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  try {
    const stdout = process.platform === 'win32'
      ? execFileSync(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', command, ...commandArgs],
        options,
      )
      : execFileSync(command, commandArgs, options);
    return { ok: true, stdout, stderr: '' };
  } catch (error) {
    const result = {
      ok: false,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || error?.message || ''),
    };
    return result;
  }
}

function installFiles(directory, files, upgrade) {
  const existing = files.map(([path, content]) => {
    if (!existsSync(path)) return null;
    if (!lstatSync(path).isFile()) fail(`existing skill file is not a regular file: ${path}`);
    const bytes = readFileSync(path);
    if (bytes.equals(Buffer.from(content))) return bytes;
    if (!upgrade || !KNOWN_INSTALLED_SHA256[path.split(/[\\/]/).pop()]?.includes(createHash('sha256').update(bytes).digest('hex'))) {
      fail(`existing skill file differs: ${path}`);
    }
    return bytes;
  });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (upgrade && existing.some((bytes, index) => bytes && !bytes.equals(Buffer.from(files[index][1])))) {
    const backup = mkdtempSync(resolve(directory, '..', '.harvest-backup-'));
    for (let index = 0; index < files.length; index += 1) {
      if (existing[index]) copyFileSync(files[index][0], resolve(backup, files[index][0].split(/[\\/]/).pop()));
    }
    console.log(`Harvest skill backup: ${backup}`);
  }
  for (let index = 0; index < files.length; index += 1) {
    const [path, content] = files[index];
    if (existing[index]?.equals(Buffer.from(content))) continue;
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  }
}

function fail(message) {
  console.error(`harvest-install: ${message}`);
  process.exit(1);
}


/** The user-scope Claude config entry for harvest-hosted, or null when there is none. */
function readClaudeMcpEntry() {
  // CLAUDE_CONFIG_DIR relocates .claude.json, exactly as it relocates the skills directory
  // above. Reading only ~/.claude.json would see no entry there and hand the user back the
  // "already exists" failure this check exists to remove.
  const configPath = resolve(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    return parsed?.mcpServers?.['harvest-hosted'] ?? null;
  } catch {
    return null;
  }
}

/** Same command and same arguments means the existing entry is already what we would write. */
function mcpEntryMatches(existing, expected) {
  if (existing === null || typeof existing !== 'object') return false;
  if (Object.getPrototypeOf(existing) !== Object.prototype) return false;
  // Exactly `command` and `args`, nothing else. An entry that matches ours but carries an
  // extra field is not ours to wave through: `env.NODE_OPTIONS` on this entry preloads
  // arbitrary code into the bridge every time Claude Code starts it. Comparing only command
  // and args would call that "already configured; nothing to change" and leave it in place.
  const keys = Object.keys(existing);
  if (keys.length !== 2 || !keys.includes('command') || !keys.includes('args')) return false;
  if (existing.command !== expected.command) return false;
  return Array.isArray(existing.args)
    && existing.args.length === expected.args.length
    && existing.args.every((value, index) => value === expected.args[index]);
}

/** Preserve unrelated client settings and refuse a competing Harvest server. */
function configureJsonMcp(configPath, bridgePath, runtime) {
  const expected = {
    ...(runtime === 'copilot' ? { type: 'local' } : {}),
    command: process.execPath,
    args: [bridgePath, '--url', 'https://tryharvest.ai/mcp'],
    ...(runtime === 'copilot' ? { tools: ['*'] } : {}),
  };
  let config = {};
  const configuredFile = lstatSync(configPath, { throwIfNoEntry: false });
  if (configuredFile) {
    if (!configuredFile.isFile()) fail('MCP configuration is not a regular file');
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
    catch { fail('MCP configuration is not valid JSON; fix it in the client before installing'); }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('MCP configuration must be an object');
  if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) {
    fail('mcpServers must be an object');
  }
  const existing = config.mcpServers?.['harvest-hosted'];
  if (existing !== undefined) {
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)
        || Object.keys(existing).length !== Object.keys(expected).length
        || Object.entries(expected).some(([key, value]) => JSON.stringify(existing[key]) !== JSON.stringify(value))) {
      fail('existing MCP server differs: harvest-hosted; reconcile it in the client before installing');
    }
    console.log(`Harvest MCP already configured for ${runtime}; nothing to change.`);
    return;
  }
  config.mcpServers = { ...config.mcpServers, 'harvest-hosted': expected };
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, configPath);
  console.log(`Harvest MCP configured for ${runtime}: ${configPath}`);
}
