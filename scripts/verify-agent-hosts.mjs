#!/usr/bin/env node
// Installer and bundled MCP consumer checks. No host/model/Meet acceptance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(process.env.HARVEST_INSTALL_ROOT || resolve(import.meta.dirname, '..'));
const home = mkdtempSync(resolve(tmpdir(), 'harvest-agent-hosts-'));
const credential = `hvst_live_${'f'.repeat(43)}`;
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: resolve(home, '.config'),
  COPILOT_HOME: resolve(home, '.copilot'), OPENCLAW_STATE_DIR: resolve(home, '.openclaw'),
  HARVEST_TOKEN: '', HARVEST_CONFIG_PATH: resolve(home, '.harvest-hosted/config.json') };
const runtimes = [
  ['cursor', '.cursor/skills/harvest', '.cursor/mcp.json'],
  ['gemini', '.gemini/skills/harvest', '.gemini/settings.json'],
  ['windsurf', '.config/devin/skills/harvest', '.config/devin/mcp_config.json'],
  ['copilot', '.copilot/skills/harvest', '.copilot/mcp-config.json'],
  ['junie', '.junie/skills/harvest', '.junie/mcp/mcp.json'],
  ['openclaw', '.openclaw/skills/harvest', null],
];
let authenticatedCalls = 0;
const endpoint = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, `Bearer ${credential}`);
  if (req.method === 'GET') { res.writeHead(405).end(); return; }
  if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
  let text = '';
  for await (const chunk of req) text += chunk;
  const message = JSON.parse(text);
  res.setHeader('Content-Type', 'application/json');
  const reply = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  if (message.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'offline-host-fixture', version: '1' } });
  else if (message.method === 'notifications/initialized') res.writeHead(202).end();
  else if (message.method === 'tools/list') reply({ tools: [{ name: 'replay_meeting_events', inputSchema: { type: 'object' } }] });
  else if (message.method === 'tools/call') {
    assert.equal(message.params.name, 'replay_meeting_events');
    assert.deepEqual(message.params.arguments, { wait_secs: 1, after_event_id: 17 });
    authenticatedCalls += 1;
    reply({ content: [{ type: 'text', text: JSON.stringify({ status: 'timeout', next_event_id: 17 }) }] });
  } else res.writeHead(400).end();
});

function install(runtime) {
  return execFileSync(process.execPath, [resolve(root, 'scripts/install.mjs'), '--runtime', runtime], { env, encoding: 'utf8', stdio: 'pipe' });
}

async function consume(command, args) {
  assert.equal(args.at(-2), '--url');
  assert.equal(args.at(-1), 'https://tryharvest.ai/mcp');
  const client = new Client({ name: 'offline-host-consumer', version: '1' });
  const transport = new StdioClientTransport({ command, args: [...args.slice(0, -1), `http://127.0.0.1:${endpoint.address().port}/mcp`], env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (data) => { stderr += data; });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'replay_meeting_events'));
    const result = await client.callTool({ name: 'replay_meeting_events', arguments: { wait_secs: 1, after_event_id: 17 } });
    assert.deepEqual(JSON.parse(result.content[0].text), { status: 'timeout', next_event_id: 17 });
  } finally { await client.close(); }
  assert.ok(!stderr.includes(credential));
}

try {
  mkdirSync(resolve(home, '.harvest-hosted'), { recursive: true });
  writeFileSync(env.HARVEST_CONFIG_PATH, JSON.stringify({ token: credential }), { mode: 0o600 });
  await new Promise((done) => endpoint.listen(0, '127.0.0.1', done));
  for (const [runtime, skillPath, configPath] of runtimes) {
    const preserved = { settings: { marker: runtime }, mcpServers: { other: { command: 'preserve-me', args: ['one'] } } };
    const target = configPath && resolve(home, configPath);
    if (target) { mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, JSON.stringify(preserved)); }
    const output = install(runtime);
    assert.ok(!output.includes(credential));
    assert.equal(readFileSync(resolve(home, skillPath, 'SKILL.md'), 'utf8'), readFileSync(resolve(root, 'skills/harvest/SKILL.md'), 'utf8'));
    assert.ok(readFileSync(resolve(home, skillPath, 'channel-bridge.mjs')).equals(readFileSync(resolve(root, 'scripts/channel-bridge.bundle.mjs'))));
    if (!target) {
      assert.match(output, /does not modify OpenClaw JSON5/);
      await consume(process.execPath, [resolve(home, skillPath, 'channel-bridge.mjs'), '--url', 'https://tryharvest.ai/mcp']);
      continue;
    }
    const configured = JSON.parse(readFileSync(target, 'utf8'));
    assert.deepEqual(configured.settings, preserved.settings);
    assert.deepEqual(configured.mcpServers.other, preserved.mcpServers.other);
    const server = configured.mcpServers['harvest-hosted'];
    assert.equal(server.command, process.execPath);
    assert.equal(server.args[0], resolve(home, skillPath, 'channel-bridge.mjs'));
    assert.ok(!JSON.stringify(configured).includes(credential));
    if (runtime === 'copilot') { assert.equal(server.type, 'local'); assert.deepEqual(server.tools, ['*']); }
    const initial = readFileSync(target);
    install(runtime); assert.ok(readFileSync(target).equals(initial), `${runtime} must be idempotent`);
    await consume(server.command, server.args);
    for (const invalid of [
      { ...configured, mcpServers: { ...configured.mcpServers, 'harvest-hosted': { ...server, env: { NODE_OPTIONS: '--require=foreign' } } } },
      { mcpServers: [] }, null,
    ]) {
      writeFileSync(target, JSON.stringify(invalid)); const before = readFileSync(target);
      assert.throws(() => install(runtime)); assert.ok(readFileSync(target).equals(before));
    }
    writeFileSync(target, 'broken JSON'); assert.throws(() => install(runtime));
    assert.equal(readFileSync(target, 'utf8'), 'broken JSON');
    rmSync(target); symlinkSync(resolve(home, 'absent-config'), target);
    assert.throws(() => install(runtime)); rmSync(target); writeFileSync(target, initial);
    const skill = resolve(home, skillPath, 'SKILL.md');
    writeFileSync(skill, 'owner edit'); assert.throws(() => install(runtime)); assert.equal(readFileSync(skill, 'utf8'), 'owner edit');
  }
  // Native manifests use the official host root variable, never the generic ${PLUGIN_ROOT}.
  for (const [file, variable] of [
    ['.claude-plugin/plugin.json', 'CLAUDE_PLUGIN_ROOT'],
    ['.cursor-plugin/plugin.json', 'CURSOR_PLUGIN_ROOT'],
    ['gemini-extension.json', 'extensionPath'],
  ]) {
    const manifestPath = resolve(root, file);
    // npm clients use the installer; these manifests are Git-distributed until packaging is coordinated.
    if (!readable(manifestPath)) {
      assert.ok(process.env.HARVEST_INSTALL_ROOT, `missing source manifest: ${file}`);
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath));
    const server = manifest.mcpServers['harvest-hosted'];
    assert.equal(server.command, 'node'); assert.equal(server.args[0], `\${${variable}}/scripts/channel-bridge.bundle.mjs`);
    assert.ok(!server.headers && !server.env);
    await consume(process.execPath, server.args.map((arg) => arg.replace(`\${${variable}}`, root)));
  }
  console.log(`PASS agent_hosts=6 config_preservation=5 collisions_refused=5 saved_credential_bridge_calls=${authenticatedCalls} secret_leaks=0 (offline fixtures, no host/Meet acceptance)`);
} finally {
  endpoint.closeAllConnections();
  await new Promise((done) => endpoint.close(done));
  rmSync(home, { recursive: true, force: true });
}

function readable(path) { try { readFileSync(path); return true; } catch { return false; } }
