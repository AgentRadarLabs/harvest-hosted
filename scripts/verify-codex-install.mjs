#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const root = resolve(process.env.HARVEST_UPGRADE_TO || resolve(import.meta.dirname, '..'));
const tempHome = mkdtempSync(join(tmpdir(), 'harvest-codex-install-'));
const codexHome = join(tempHome, 'codex-home');
const binDirectory = join(tempHome, 'bin');
const capturePath = join(tempHome, 'codex-mcp-calls.jsonl');
const statePath = join(tempHome, 'codex-mcp-state.json');
const token = `hvst_live_${'c'.repeat(43)}`;
// An unpacked, verified prior release enables the actual customer upgrade check.
const previousRoot = process.env.HARVEST_UPGRADE_FROM;

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

  install(env, [], previousRoot || root);
  const initialConfig = readFileSync(statePath);
  if (previousRoot) install(env, ['--upgrade']);
  install(env);
  if (!readFileSync(statePath).equals(initialConfig)) throw new Error('upgrade changed MCP configuration ownership');

  const target = join(codexHome, 'skills', 'harvest');
  const bridgePath = join(target, 'channel-bridge.mjs');
  for (const file of ['SKILL.md', 'register.mjs', 'mcp-headers.mjs', 'channel-bridge.mjs']) {
    if (!existsSync(join(target, file))) throw new Error(`missing installed file: ${file}`);
  }

  if (!readFileSync(bridgePath).equals(readFileSync(join(root, 'scripts', 'channel-bridge.bundle.mjs')))) {
    throw new Error('installed bridge differs from the current release');
  }

  const calls = readFileSync(capturePath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  if (calls.length !== (previousRoot ? 4 : 3)) throw new Error(`unexpected install/upgrade call count: ${calls.length}`);
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

  if (previousRoot) {
    const backups = readdirSync(join(codexHome, 'skills')).filter((name) => name.startsWith('.harvest-backup-'));
    if (backups.length !== 1) throw new Error('upgrade must retain exactly one prior release backup');
    for (const [file, source] of [
      ['SKILL.md', 'skills/harvest/SKILL.md'], ['register.mjs', 'scripts/register.mjs'],
      ['mcp-headers.mjs', 'scripts/mcp-headers.mjs'], ['channel-bridge.mjs', 'scripts/channel-bridge.bundle.mjs'],
    ]) {
      if (!readFileSync(join(codexHome, 'skills', backups[0], file)).equals(readFileSync(join(previousRoot, source)))) {
        throw new Error(`prior release backup mismatch: ${file}`);
      }
    }
  }
  install(env, ['--upgrade']);
  const cleanBridge = readFileSync(bridgePath);
  const editedBridge = Buffer.concat([cleanBridge, Buffer.from('\nlocal bridge edit\n')]);
  writeFileSync(bridgePath, editedBridge);
  let refusedBridge = false;
  try { install(env, ['--upgrade']); } catch { refusedBridge = true; }
  if (!refusedBridge || !readFileSync(bridgePath).equals(editedBridge) || !readFileSync(statePath).equals(initialConfig)) {
    throw new Error('upgrade overwrote an unknown bridge or its MCP configuration');
  }
  writeFileSync(bridgePath, cleanBridge);
  const editedSkill = `${readFileSync(join(target, 'SKILL.md'), 'utf8')}\nlocal edit\n`;
  writeFileSync(join(target, 'SKILL.md'), editedSkill);
  let refused = false;
  try { install(env, ['--upgrade']); } catch { refused = true; }
  if (!refused || readFileSync(join(target, 'SKILL.md'), 'utf8') !== editedSkill) {
    throw new Error('upgrade overwrote a user-modified skill');
  }

  if (previousRoot) console.log('PASS published_upgrade=green prior_files_backup=exact mcp_config=unchanged unknown_bridge=refused');
  console.log('PASS codex_skill_install=green mcp_auto_config=green idempotent=green cli_secret_leaks=0');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

function install(env, extra = [], installRoot = root) {
  execFileSync(process.execPath, [join(installRoot, 'scripts', 'install.mjs'), '--runtime', 'codex', ...extra], {
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
