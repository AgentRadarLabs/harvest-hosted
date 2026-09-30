#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const directory = await mkdtemp(resolve(tmpdir(), 'harvest-credentials-'));
let requests = 0;
const endpoint = createServer((_request, response) => { requests += 1; response.end(); });
await new Promise((done) => endpoint.listen(0, '127.0.0.1', done));
const sentinel = 'private-invalid-credential-sentinel';
const saved = resolve(directory, 'saved.json');
await writeFile(saved, JSON.stringify({ token: `hvst_live_${'A'.repeat(43)}` }), { mode: 0o600 });
const env = { ...process.env, HARVEST_TOKEN: '', HARVEST_CONFIG_PATH: resolve(directory, 'absent.json') };

async function run(file, overrides, initialize) {
  const child = spawn(process.execPath, [resolve(import.meta.dirname, file), '--url', `http://127.0.0.1:${endpoint.address().port}/mcp`], {
    env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 8_000);
  if (initialize) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'offline-credential-check', version: '1' } } }) + '\n');
  const status = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  clearTimeout(timeout);
  assert.equal(status, 1);
  assert.match(stderr, /https:\/\/tryharvest.ai\/agents/);
  assert.match(stderr, /register.mjs import-env/);
  assert.ok(!`${stdout}${stderr}`.includes(sentinel));
  if (initialize) {
    const message = JSON.parse(stdout.trim());
    assert.equal(message.id, 17); assert.equal(message.error.code, -32001);
    assert.match(message.error.message, /HARVEST_TOKEN in the environment/);
    assert.ok(!('result' in message));
  } else assert.equal(stdout, '');
}
try {
  for (const file of ['channel-bridge.mjs', 'channel-bridge.bundle.mjs']) {
    await run(file, {}, true);
    await run(file, { HARVEST_TOKEN: sentinel, HARVEST_CONFIG_PATH: saved }, true);
  }
  const start = Date.now();
  await run('channel-bridge.bundle.mjs', {}, false);
  assert.ok(Date.now() - start < 7_000, 'missing initialize must terminate within the own deadline');
  assert.equal(requests, 0, 'invalid credentials must never contact the remote endpoint');
  console.log('bridge credential failure verified: actionable protocol/stderr, secret redaction, environment precedence, bounded exit, zero upstream requests');
} finally {
  await new Promise((done) => endpoint.close(done));
  await rm(directory, { recursive: true, force: true });
}
