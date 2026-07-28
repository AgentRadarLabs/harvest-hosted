#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const DEFAULT_API_URL = 'https://tryharvest.ai';
const values = process.argv.slice(2);
const action = values.shift();

try {
  if (action === 'send' || action === 'verify') {
    console.log(JSON.stringify(await register(action, values)));
  } else if (action === 'import-env') {
    console.log(JSON.stringify(importEnvironmentCredential(values)));
  } else if (action === 'probe') {
    console.log(JSON.stringify(await probe(values)));
  } else {
    fail('Usage: register.mjs import-env | send --email EMAIL --api-url URL | verify --email EMAIL --code CODE --api-url URL | probe [--mcp-url URL]');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : 'Harvest registration failed');
}

async function register(action, args) {
  const options = parseRegistrationArgs(action, args);
  if (action === 'send') {
    const response = await postJson(`${options.apiUrl}/api/register/send`, { email: options.email });
    if (!response.ok) throw new Error(`Registration send failed HTTP ${response.status}`);
    return {
      event: 'otp_sent',
      expires_in_seconds: positiveInteger(response.body.expires_in_seconds, 600),
      note: 'Check the inbox for the six-digit Harvest code.',
    };
  }

  const response = await postJson(`${options.apiUrl}/api/register/verify`, {
    email: options.email,
    code: options.code,
  });
  if (!response.ok) throw new Error(`Registration verify failed HTTP ${response.status}`);
  const token = response.body?.credential?.token;
  if (typeof token !== 'string' || !/^hvst_live_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('Registration response did not contain a valid one-time API key');
  }
  const accountId = safeIdentifier(response.body?.account?.account_id, 'account_id');
  const agentId = safeIdentifier(response.body?.agent?.agent_id, 'agent_id');
  const fingerprint = safeFingerprint(response.body?.credential?.fingerprint);
  writeConfig({ ...readConfig(), api_url: options.apiUrl, token });
  return {
    event: 'registered',
    account_id: accountId,
    agent_id: agentId,
    api_key_prefix: fingerprint,
    saved: configPath(),
    trial: {
      enabled: response.body?.trial?.enabled === true,
      live_charges: false,
    },
  };
}

function importEnvironmentCredential(args) {
  if (args.length !== 0) throw new Error('import-env does not accept arguments');
  const token = (process.env.HARVEST_TOKEN || '').trim();
  if (!/^hvst_live_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('HARVEST_TOKEN does not contain a valid Harvest credential');
  }
  const apiUrl = (process.env.HARVEST_REGISTRATION_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
  validateEndpoint(apiUrl, 'Harvest registration URL');
  writeConfig({ ...readConfig(), api_url: apiUrl, token });
  return {
    event: 'credential_saved',
    api_key_prefix: createHash('sha256').update(token).digest('hex').slice(0, 12),
    saved: configPath(),
  };
}

async function probe(args) {
  const config = readConfig();
  const token = typeof config.token === 'string' && config.token.trim() === config.token ? config.token : '';
  if (!token) throw new Error('No saved Harvest API key; complete registration first');
  let mcpUrl = typeof config.api_url === 'string' ? `${config.api_url.replace(/\/+$/, '')}/mcp` : '';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--mcp-url') mcpUrl = requiredValue(args, ++index, '--mcp-url');
    else throw new Error(`Unknown probe option: ${args[index]}`);
  }
  if (!mcpUrl) throw new Error('MCP URL is required');
  validateEndpoint(mcpUrl, 'MCP URL');
  const sessionId = await initializeMcp(mcpUrl, token);
  return { event: 'mcp_probe_pass', session_created: Boolean(sessionId) };
}

function parseRegistrationArgs(action, args) {
  const parsed = {
    email: '',
    code: '',
    apiUrl: (process.env.HARVEST_REGISTRATION_API_URL || DEFAULT_API_URL).replace(/\/+$/, ''),
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--email') parsed.email = requiredValue(args, ++index, value).trim().toLowerCase();
    else if (value === '--code') parsed.code = requiredValue(args, ++index, value).trim();
    else if (value === '--api-url') parsed.apiUrl = requiredValue(args, ++index, value).replace(/\/+$/, '');
    else throw new Error(`Unknown register option: ${value}`);
  }
  if (!validEmail(parsed.email)) throw new Error('email is invalid');
  if (action === 'verify' && !/^\d{6}$/.test(parsed.code)) throw new Error('code must contain six digits');
  validateEndpoint(parsed.apiUrl, 'Harvest registration URL');
  return parsed;
}

async function postJson(url, body, headers = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('Harvest endpoint is unavailable');
  }
  let parsed = {};
  try { parsed = await response.json(); } catch { parsed = {}; }
  return { ok: response.ok, status: response.status, body: parsed, headers: response.headers };
}

async function initializeMcp(url, token) {
  const protocolVersion = '2025-06-18';
  const initializeId = 'harvest-registration-probe';
  let sessionId = '';
  try {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: mcpHeaders(token, '', protocolVersion),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: initializeId,
          method: 'initialize',
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: 'harvest-registration-probe', version: '1' },
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('Harvest endpoint is unavailable');
    }
    const source = await response.text();
    if (!response.ok) throw new Error(`Harvest MCP probe failed HTTP ${response.status}`);
    const message = parseInitializeResponse(source, response.headers.get('content-type') || '', initializeId);
    if (message.id !== initializeId || !Object.hasOwn(message, 'result')) {
      throw new Error('Harvest MCP initialize response was invalid');
    }
    sessionId = response.headers.get('mcp-session-id') || '';
    const notification = await fetch(url, {
      method: 'POST',
      headers: mcpHeaders(token, sessionId, protocolVersion),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      signal: AbortSignal.timeout(30_000),
    });
    await notification.arrayBuffer();
    if (!notification.ok) throw new Error(`Harvest MCP initialized notification failed HTTP ${notification.status}`);
    return sessionId;
  } finally {
    if (sessionId) {
      try {
        const response = await fetch(url, {
          method: 'DELETE',
          headers: mcpHeaders(token, sessionId, protocolVersion),
          signal: AbortSignal.timeout(30_000),
        });
        await response.arrayBuffer();
      } catch {
        // Closing the short-lived verification session is best-effort.
      }
    }
  }
}

function parseInitializeResponse(source, contentType, initializeId) {
  const payloads = contentType.toLowerCase().includes('text/event-stream')
    ? source.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
    : [source.trim()];
  for (const payload of payloads) {
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.id === initializeId) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  throw new Error('Harvest MCP initialize response was invalid');
}

function mcpHeaders(token, sessionId, protocolVersion) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': protocolVersion,
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
  };
}

function configPath() {
  return process.env.HARVEST_CONFIG_PATH || resolve(homedir(), '.harvest-hosted', 'config.json');
}

function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfig(config) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    if (!existsSync(path)) throw error;
    rmSync(path, { force: true });
    renameSync(temporaryPath, path);
  }
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function validateEndpoint(value, label) {
  let endpoint;
  try { endpoint = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:')) {
    throw new Error(`${label} must use HTTPS, except loopback offline tests`);
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error(`${label} must not contain credentials, query, or fragment`);
  }
}

function requiredValue(args, index, option) {
  if (!args[index]) throw new Error(`${option} requires a value`);
  return args[index];
}

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safeIdentifier(value, field) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) {
    throw new Error(`Registration response ${field} is invalid`);
  }
  return value;
}

function safeFingerprint(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{12}$/.test(value)) {
    throw new Error('Registration response fingerprint is invalid');
  }
  return value;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function fail(message) {
  console.error(`harvest-register: ${message}`);
  process.exit(1);
}
