#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tempHome = await mkdtemp(join(tmpdir(), 'harvest-skill-registration-'));
const configPath = join(tempHome, 'config.json');
const importedConfigPath = join(tempHome, 'imported-config.json');
const rawToken = `hvst_live_${'a'.repeat(43)}`;
const requests = [];

const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  requests.push({
    path: new URL(request.url || '/', 'http://test').pathname,
    method: request.method,
    body: body ? JSON.parse(body) : null,
    authorization: request.headers.authorization,
  });
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/api/register/send') {
    response.end(JSON.stringify({ ok: true, expires_in_seconds: 600 }));
    return;
  }
  if (request.url === '/api/register/verify') {
    response.end(JSON.stringify({
      account: { account_id: 'acct_test' },
      agent: { agent_id: 'agent_test' },
      credential: { token: rawToken, fingerprint: 'aaaaaaaaaaaa' },
      trial: { enabled: true, live_charges: false },
    }));
    return;
  }
  if (request.url === '/mcp' && body && JSON.parse(body).method === 'initialize') {
    response.setHeader('Mcp-Session-Id', 'registration-smoke');
    response.setHeader('Content-Type', 'text/event-stream');
    response.end(`event: message\ndata: ${JSON.stringify({
      jsonrpc: '2.0', id: 'harvest-registration-probe', result: {},
    })}\n\n`);
    return;
  }
  response.statusCode = request.method === 'DELETE' ? 200 : 202;
  response.end();
});

try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake gateway did not bind');
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const env = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    CODEX_HOME: join(tempHome, '.codex'),
    HARVEST_CONFIG_PATH: configPath,
  };

  await expectPass(['scripts/install.mjs', '--runtime', 'codex'], env);
  const installedSkill = await readFile(join(tempHome, '.codex', 'skills', 'harvest', 'SKILL.md'), 'utf8');
  requireText(installedSkill, 'scripts/register.mjs');
  requireText(installedSkill, 'HARVEST_REGISTRATION_API_URL');

  const imported = await expectPass(
    ['scripts/register.mjs', 'import-env'],
    {
      ...env,
      HARVEST_CONFIG_PATH: importedConfigPath,
      HARVEST_TOKEN: rawToken,
      HARVEST_REGISTRATION_API_URL: apiUrl,
    },
  );
  assertJson(imported.stdout, {
    event: 'credential_saved',
    api_key_prefix: createHash('sha256').update(rawToken).digest('hex').slice(0, 12),
    saved: importedConfigPath,
  });
  const importedSaved = JSON.parse(await readFile(importedConfigPath, 'utf8'));
  if (importedSaved.token !== rawToken || importedSaved.api_url !== apiUrl) {
    throw new Error('imported environment credential config mismatch');
  }

  const sent = await expectPass([
    'scripts/register.mjs', 'send', '--email', 'New.User@example.com', '--api-url', apiUrl,
  ], env);
  assertJson(sent.stdout, { event: 'otp_sent', expires_in_seconds: 600 });

  const verified = await expectPass([
    'scripts/register.mjs', 'verify', '--email', 'New.User@example.com', '--code', '123456',
    '--api-url', apiUrl,
  ], env);
  assertJson(verified.stdout, {
    event: 'registered',
    account_id: 'acct_test',
    agent_id: 'agent_test',
    api_key_prefix: 'aaaaaaaaaaaa',
  });

  const probe = await expectPass([
    'scripts/register.mjs', 'probe', '--mcp-url', `${apiUrl}/mcp`,
  ], env);
  assertJson(probe.stdout, { event: 'mcp_probe_pass' });

  const combinedOutput = `${imported.stdout}${imported.stderr}${sent.stdout}${sent.stderr}${verified.stdout}${verified.stderr}${probe.stdout}${probe.stderr}`;
  if (combinedOutput.includes(rawToken) || combinedOutput.includes('123456')) {
    throw new Error('credential material leaked to process output');
  }
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  if (saved.token !== rawToken || saved.api_url !== apiUrl) throw new Error('saved registration config mismatch');
  if (process.platform !== 'win32' && ((await stat(configPath)).mode & 0o777) !== 0o600) {
    throw new Error('registration config mode is not 0600');
  }

  const expectedPaths = ['/api/register/send', '/api/register/verify', '/mcp', '/mcp', '/mcp'];
  if (JSON.stringify(requests.map((request) => request.path)) !== JSON.stringify(expectedPaths)) {
    throw new Error(`unexpected request path sequence: ${requests.map((request) => request.path).join(',')}`);
  }
  for (const request of requests.slice(2)) {
    if (request.authorization !== `Bearer ${rawToken}`) throw new Error('MCP request missed saved bearer token');
  }
  console.log('PASS clone_skill_register_key_mcp=green output_secrets=0 config_mode=private');
} finally {
  await new Promise((done) => server.close(() => done()));
  await rm(tempHome, { recursive: true, force: true });
}

function expectPass(args, env) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('close', (code) => {
      if (code === 0) done({ stdout, stderr });
      else reject(new Error(`command failed exit=${code}: ${args.join(' ')}\n${stderr}`));
    });
  });
}

function assertJson(source, expected) {
  const actual = JSON.parse(source);
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw new Error(`JSON field ${key} mismatch`);
  }
}

function requireText(source, expected) {
  if (!source.includes(expected)) throw new Error(`installed skill missing ${expected}`);
}
