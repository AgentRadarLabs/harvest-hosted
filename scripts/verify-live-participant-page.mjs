#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const bridgePath = resolve(process.argv[2] || '');
if (!process.argv[2]) fail('bridge path is required');
if (!process.env.HARVEST_CONFIG_PATH) fail('HARVEST_CONFIG_PATH is required');

let submitted = '';
const localServer = createServer((request, response) => {
  void (async () => {
    if (request.method === 'POST' && request.url === '/submit') {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      submitted = Buffer.concat(chunks).toString('utf8');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ received: true }));
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>Clean package participant page</title>');
  })();
});
await new Promise((resolvePromise, reject) => {
  localServer.once('error', reject);
  localServer.listen(0, '127.0.0.1', resolvePromise);
});
const address = localServer.address();
if (!address || typeof address === 'string') fail('local page did not bind');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bridgePath],
  env: { ...process.env },
  stderr: 'pipe',
});
const client = new Client({ name: 'harvest-clean-package-proof', version: '1.0.0' });

try {
  await client.connect(transport);
  const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
  if (!toolNames.includes('open_participant_page') || !toolNames.includes('close_participant_page')) {
    throw new Error('participant page tools missing');
  }
  const opened = structured(await client.callTool({
    name: 'open_participant_page',
    arguments: { port: address.port },
  }));
  if (opened?.status !== 'completed' || typeof opened.url !== 'string') {
    throw new Error(`open failed: ${opened?.status ?? 'missing'}`);
  }
  const serialized = JSON.stringify(opened);
  if (serialized.includes('access_key') || serialized.includes('page_id')) {
    throw new Error('private tunnel material leaked into tool output');
  }
  const html = await fetch(opened.url);
  if (html.status !== 200 || !(await html.text()).includes('Clean package participant page')) {
    throw new Error('public GET did not reach clean-package local server');
  }
  const posted = await fetch(new URL('submit', opened.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'proof=clean-package',
  });
  if (posted.status !== 200 || submitted !== 'proof=clean-package') {
    throw new Error('public POST did not reach clean-package local server');
  }
  const closed = structured(await client.callTool({
    name: 'close_participant_page',
    arguments: {},
  }));
  if (closed?.status !== 'completed' || closed.closed !== true) {
    throw new Error('close tool did not close the page');
  }
  const revoked = await fetch(opened.url);
  if (revoked.status !== 404) throw new Error(`revoked page returned HTTP ${revoked.status}`);

  console.log(
    `PASS clean_bundle_tools=green get=200 post=200 submission=${submitted} `
      + `close=true revoked=404 secret_fields=0`,
  );
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  await new Promise((resolvePromise) => localServer.close(resolvePromise));
}

function structured(result) {
  return result?.structuredContent;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
