#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let initialized = 0;
let expiredCalls = 0;
let freshCalls = 0;
const server = createServer(async (req, res) => {
  if (req.method === 'GET') { res.writeHead(405).end(); return; }
  if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
  let text = '';
  for await (const chunk of req) text += chunk;
  const message = JSON.parse(text);
  const session = req.headers['mcp-session-id'];
  res.setHeader('Content-Type', 'application/json');
  if (message.method === 'initialize') {
    initialized += 1;
    res.setHeader('Mcp-Session-Id', `session-${initialized}`);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' },
    } }));
  } else if (message.method === 'notifications/initialized') {
    res.writeHead(202).end();
  } else if (message.method === 'tools/list') {
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [
      { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } },
    ] } }));
  } else if (message.method === 'tools/call' && session === 'session-1') {
    expiredCalls += 1;
    res.writeHead(404).end(JSON.stringify({ jsonrpc: '2.0', id: null,
      error: { code: -32001, message: 'Session not found' } }));
  } else if (message.method === 'tools/call' && session === 'session-2') {
    if (message.params.arguments?.missing) {
      res.writeHead(404).end(JSON.stringify({ jsonrpc: '2.0', id: null,
        error: { code: -32001, message: 'Agent not found' } }));
      return;
    }
    freshCalls += 1;
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: 'fresh session' }],
    } }));
  } else {
    res.writeHead(400).end();
  }
});

let client;
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, 'channel-bridge.bundle.mjs'), '--url', `http://127.0.0.1:${port}/mcp`],
    env: { ...process.env, HARVEST_TOKEN: `hvst_live_${'a'.repeat(43)}` },
    stderr: 'pipe',
  });
  client = new Client({ name: 'bridge-reconnect-check', version: '1' });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools[0].name, 'echo');
  const results = await Promise.all([
    client.callTool({ name: 'echo', arguments: {} }),
    client.callTool({ name: 'echo', arguments: {} }),
  ]);
  for (const result of results) assert.equal(result.content[0].text, 'fresh session');
  assert.equal(initialized, 2);
  assert.equal(expiredCalls, 2);
  assert.equal(freshCalls, 2);
  await assert.rejects(client.callTool({ name: 'echo', arguments: { missing: true } }), /Agent not found/);
  assert.equal(initialized, 2);
  console.log('PASS bridge_reconnect=green concurrent_calls=2 reinitializations=1');
} finally {
  await client?.close().catch(() => undefined);
  await new Promise((done) => server.close(done));
}
