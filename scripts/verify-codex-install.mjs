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
const tempHome = mkdtempSync(join(tmpdir(), 'harvest-codex-install-'));
const codexHome = join(tempHome, 'codex-home');
const binDirectory = join(tempHome, 'bin');
const capturePath = join(tempHome, 'codex-mcp-calls.jsonl');
const statePath = join(tempHome, 'codex-mcp-state.json');
const token = `hvst_live_${'c'.repeat(43)}`;

try {
  mkdirSync(binDirectory, { recursive: true });
  installFakeCodex(binDirectory);
  const env = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    CODEX_HOME: codexHome,
    HARVEST_CODEX_CAPTURE: capturePath,
    HARVEST_CODEX_STATE: statePath,
    HARVEST_TOKEN: token,
    PATH: `${binDirectory}${delimiter}${process.env.PATH || ''}`,
  };

  install(env);
  install(env);

  const target = join(codexHome, 'skills', 'harvest');
  const bridgePath = join(target, 'channel-bridge.mjs');
  for (const file of ['SKILL.md', 'register.mjs', 'mcp-headers.mjs', 'channel-bridge.mjs']) {
    if (!existsSync(join(target, file))) throw new Error(`missing installed file: ${file}`);
  }

  const calls = readFileSync(capturePath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  if (calls.length !== 3) throw new Error(`expected get/add/get calls, got ${calls.length}`);
  if (JSON.stringify(calls).includes(token)) throw new Error('token leaked into Codex CLI arguments');
  if (JSON.stringify(calls[0]) !== JSON.stringify(['mcp', 'get', 'harvest-hosted', '--json'])) {
    throw new Error(`unexpected first Codex call: ${JSON.stringify(calls[0])}`);
  }
  if (JSON.stringify(calls[2]) !== JSON.stringify(['mcp', 'get', 'harvest-hosted', '--json'])) {
    throw new Error(`unexpected idempotency Codex call: ${JSON.stringify(calls[2])}`);
  }

  const configured = JSON.parse(readFileSync(statePath, 'utf8'));
  if (configured.transport.command !== process.execPath) {
    throw new Error(`Codex bridge executable mismatch: ${configured.transport.command}`);
  }
  if (JSON.stringify(configured.transport.args) !== JSON.stringify([
    bridgePath, '--url', 'https://tryharvest.ai/mcp',
  ])) {
    throw new Error(`Codex bridge arguments mismatch: ${JSON.stringify(configured.transport.args)}`);
  }
  if (!configured.enabled || configured.transport.type !== 'stdio') {
    throw new Error('Codex Harvest MCP server is not enabled stdio');
  }

  console.log('PASS codex_skill_install=green mcp_auto_config=green idempotent=green cli_secret_leaks=0');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

function install(env) {
  execFileSync(process.execPath, [join(root, 'scripts', 'install.mjs'), '--runtime', 'codex'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function installFakeCodex(directory) {
  const fakeScript = join(directory, 'fake-codex.cjs');
  writeFileSync(fakeScript, [
    "const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');",
    'const args = process.argv.slice(2);',
    "appendFileSync(process.env.HARVEST_CODEX_CAPTURE, `${JSON.stringify(args)}\\n`);",
    "if (args[0] !== 'mcp') process.exit(2);",
    "if (args[1] === 'get') {",
    "  if (!existsSync(process.env.HARVEST_CODEX_STATE)) {",
    "    console.error(\"Error: No MCP server named 'harvest-hosted' found.\");",
    '    process.exit(1);',
    '  }',
    "  process.stdout.write(readFileSync(process.env.HARVEST_CODEX_STATE, 'utf8'));",
    '  process.exit(0);',
    '}',
    "if (args[1] === 'add') {",
    "  const separator = args.indexOf('--');",
    "  const command = args[separator + 1];",
    "  const commandArgs = args.slice(separator + 2);",
    '  writeFileSync(process.env.HARVEST_CODEX_STATE, JSON.stringify({',
    "    name: 'harvest-hosted', enabled: true,",
    "    transport: { type: 'stdio', command, args: commandArgs, env: null },",
    '  }));',
    '  process.exit(0);',
    '}',
    'process.exit(2);',
  ].join('\n'));

  if (process.platform === 'win32') {
    writeFileSync(join(directory, 'codex.cmd'), `@"${process.execPath}" "%~dp0fake-codex.cjs" %*\r\n`);
    return;
  }
  const executable = join(directory, 'codex');
  writeFileSync(executable, `#!${process.execPath}\nrequire('./fake-codex.cjs');\n`);
  chmodSync(executable, 0o755);
}
