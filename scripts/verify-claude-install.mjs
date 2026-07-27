#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tempHome = mkdtempSync(join(tmpdir(), 'harvest-claude-install-'));
const claudeConfig = join(tempHome, 'claude-config');
const binDirectory = join(tempHome, 'bin');
const capturePath = join(tempHome, 'claude-mcp-calls.jsonl');
const harvestConfig = join(tempHome, 'harvest-config.json');
const token = `hvst_live_${'b'.repeat(43)}`;

try {
  mkdirSync(binDirectory, { recursive: true });
  installFakeClaude(binDirectory);
  writeFileSync(harvestConfig, `${JSON.stringify({
    api_url: 'https://tryharvest.ai',
    token,
  })}\n`, { mode: 0o600 });

  const env = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    HARVEST_CLAUDE_CAPTURE: capturePath,
    HARVEST_CONFIG_PATH: harvestConfig,
    PATH: `${binDirectory}${delimiter}${process.env.PATH || ''}`,
  };

  install(env);
  install(env);

  const target = join(claudeConfig, 'skills', 'harvest');
  const helperPath = join(target, 'mcp-headers.mjs');
  requireFile(join(target, 'SKILL.md'));
  requireFile(join(target, 'register.mjs'));
  requireFile(helperPath);

  const calls = readFileSync(capturePath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  if (calls.length !== 2) throw new Error(`expected two idempotent MCP registrations, got ${calls.length}`);
  for (const args of calls) {
    if (JSON.stringify(args).includes(token)) throw new Error('token leaked into Claude CLI arguments');
    if (JSON.stringify(args.slice(0, 5)) !== JSON.stringify([
      'mcp', 'add-json', '--scope', 'user', 'harvest',
    ])) throw new Error(`unexpected Claude CLI arguments: ${JSON.stringify(args)}`);
    const config = JSON.parse(args[5]);
    if (config.type !== 'http' || config.url !== 'https://tryharvest.ai/mcp') {
      throw new Error('Harvest MCP transport mismatch');
    }
    if (typeof config.headersHelper !== 'string' || !config.headersHelper.includes('mcp-headers.mjs')) {
      throw new Error('dynamic authorization helper missing');
    }
  }

  const headers = JSON.parse(execFileSync(process.execPath, [helperPath], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  if (headers.Authorization !== `Bearer ${token}`) throw new Error('authorization helper output mismatch');

  console.log('PASS claude_skill_install=green mcp_user_scope=green dynamic_auth=green idempotent=green cli_secret_leaks=0');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

function install(env) {
  execFileSync(process.execPath, [join(root, 'scripts', 'install.mjs'), '--runtime', 'claude-code'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function installFakeClaude(directory) {
  const fakeScript = join(directory, 'fake-claude.cjs');
  writeFileSync(fakeScript, [
    "const { appendFileSync } = require('node:fs');",
    "appendFileSync(process.env.HARVEST_CLAUDE_CAPTURE, `${JSON.stringify(process.argv.slice(2))}\\n`);",
  ].join('\n'));

  if (process.platform === 'win32') {
    writeFileSync(join(directory, 'claude.cmd'), `@\"${process.execPath}\" \"%~dp0fake-claude.cjs\" %*\r\n`);
    return;
  }

  const executable = join(directory, 'claude');
  writeFileSync(executable, `#!${process.execPath}\nrequire('./fake-claude.cjs');\n`);
  chmodSync(executable, 0o755);
}

function requireFile(path) {
  if (!existsSync(path)) throw new Error(`missing installed file: ${path}`);
}
