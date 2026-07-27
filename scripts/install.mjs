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
const targetPath = resolve(targetDirectory, 'SKILL.md');
const registrationTargetPath = resolve(targetDirectory, 'register.mjs');
const mcpHeadersTargetPath = resolve(targetDirectory, 'mcp-headers.mjs');
assertCompatible(targetPath, source);
assertCompatible(registrationTargetPath, registrationSource);
assertCompatible(mcpHeadersTargetPath, mcpHeadersSource);

mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
writeIfMissing(targetPath, source);
writeIfMissing(registrationTargetPath, registrationSource);
writeIfMissing(mcpHeadersTargetPath, mcpHeadersSource);
if (runtime === 'claude-code') configureClaudeMcp(mcpHeadersTargetPath);
console.log(`Harvest skill installed for ${runtime}: ${targetPath}`);

function configureClaudeMcp(headersHelperPath) {
  const server = JSON.stringify({
    type: 'http',
    url: 'https://gateway.84.32.83.100.sslip.io/mcp',
    headersHelper: `${shellQuote(process.execPath)} ${shellQuote(headersHelperPath)}`,
  });
  const command = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const commandArgs = ['mcp', 'add-json', '--scope', 'user', 'harvest', server];
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

function shellQuote(value) {
  if (/[\0\r\n]/.test(value)) fail('unsafe path while configuring Claude MCP');
  if (process.platform === 'win32') {
    if (value.includes('"')) fail('unsafe quote in path while configuring Claude MCP');
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
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
