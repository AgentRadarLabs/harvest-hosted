#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(repositoryRoot, 'SKILL.md');
const registrationSourcePath = resolve(repositoryRoot, 'scripts', 'register.mjs');
const mcpHeadersSourcePath = resolve(repositoryRoot, 'scripts', 'mcp-headers.mjs');
const bridgeSourcePath = resolve(repositoryRoot, 'scripts', 'channel-bridge.bundle.mjs');
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/install.mjs --runtime <codex|claude-code>');
  process.exit(0);
}

const runtimeIndex = args.indexOf('--runtime');
const runtime = runtimeIndex >= 0 ? args[runtimeIndex + 1] : '';
if (!runtime || args.length !== 2 || runtimeIndex !== 0) {
  fail('expected exactly --runtime <codex|claude-code>');
}

const targetDirectories = {
  codex: resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'skills', 'harvest'),
  'claude-code': resolve(process.env.CLAUDE_CONFIG_DIR || resolve(homedir(), '.claude'), 'skills', 'harvest'),
};
const targetDirectory = targetDirectories[runtime];
if (!targetDirectory) fail('runtime must be codex or claude-code');

const source = readFileSync(sourcePath, 'utf8');
const registrationSource = readFileSync(registrationSourcePath, 'utf8');
const mcpHeadersSource = readFileSync(mcpHeadersSourcePath, 'utf8');
const bridgeSource = readFileSync(bridgeSourcePath, 'utf8');
const targetPath = resolve(targetDirectory, 'SKILL.md');
const registrationTargetPath = resolve(targetDirectory, 'register.mjs');
const mcpHeadersTargetPath = resolve(targetDirectory, 'mcp-headers.mjs');
const bridgeTargetPath = resolve(targetDirectory, 'channel-bridge.mjs');
assertCompatible(targetPath, source);
assertCompatible(registrationTargetPath, registrationSource);
assertCompatible(mcpHeadersTargetPath, mcpHeadersSource);
assertCompatible(bridgeTargetPath, bridgeSource);

mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
writeIfMissing(targetPath, source);
writeIfMissing(registrationTargetPath, registrationSource);
writeIfMissing(mcpHeadersTargetPath, mcpHeadersSource);
writeIfMissing(bridgeTargetPath, bridgeSource);
if (runtime === 'claude-code') configureClaudeMcp(bridgeTargetPath);
if (runtime === 'codex') configureCodexMcp(bridgeTargetPath);
console.log(`Harvest skill installed for ${runtime}: ${targetPath}`);

function configureClaudeMcp(bridgePath) {
  const server = JSON.stringify({
    command: process.execPath,
    args: [bridgePath, '--url', 'https://tryharvest.ai/mcp'],
  });
  const command = process.platform === 'win32' ? 'claude.cmd' : 'claude';
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

function assertCompatible(path, expected) {
  if (existsSync(path) && readFileSync(path, 'utf8') !== expected) fail(`existing skill file differs: ${path}`);
}

function writeIfMissing(path, content) {
  if (!existsSync(path)) writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' });
}

function fail(message) {
  console.error(`harvest-install: ${message}`);
  process.exit(1);
}
