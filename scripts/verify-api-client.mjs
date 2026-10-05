import assert from 'node:assert/strict';
import { HarvestApi } from './api-client.mjs';

const calls = [];
const testKey = ['hvst', 'dev', 'test'].join('_');
const api = new HarvestApi({
  apiKey: testKey,
  baseUrl: 'https://example.test/',
  fetch: async (url, init) => {
    calls.push({ url, ...init });
    return { ok: true, json: async () => ({ voices: [{ voice_preset: 'catalog-voice-1' }], identities: [] }) };
  },
});

assert.deepEqual(await api.voices(), [{ voice_preset: 'catalog-voice-1' }]);
assert.equal(calls[0].url, 'https://example.test/api/catalog/identities');
assert.equal(calls[0].headers.Authorization, 'Bearer hvst_dev_test');
await api.configureAgent('agent/1', { identity_id: 'cube', voice_preset: 'catalog-voice-1' });
assert.equal(calls[1].url, 'https://example.test/api/agents/agent%2F1/identity');
assert.equal(calls[1].method, 'PATCH');
assert.deepEqual(JSON.parse(calls[1].body), { identity_id: 'cube', voice_preset: 'catalog-voice-1' });
await api.agent('agent/2');
assert.equal(calls[2].url, 'https://example.test/api/agents/agent%2F2');
await api.revokeAgentToken('agent/2', 'cred/3');
assert.equal(calls[3].url, 'https://example.test/api/agents/agent%2F2/credentials/cred%2F3/revoke');
assert.deepEqual(await api.voices({ locale: 'ru-RU', tag: 'friendly voice', gender: 'female', ignored: 'x' }), [{ voice_preset: 'catalog-voice-1' }]);
assert.equal(calls[4].url, 'https://example.test/api/catalog/identities?locale=ru-RU&tag=friendly+voice&gender=female');
assert.equal(calls[4].headers.Authorization, 'Bearer hvst_dev_test');
await api.createAgent({ display_name: 'Sam', identity_id: 'sam', voice_preset: 'catalog-voice-1' }, { idempotencyKey: 'request-1' });
assert.equal(calls[5].headers['Idempotency-Key'], 'request-1');
assert.deepEqual(JSON.parse(calls[5].body), { display_name: 'Sam', identity_id: 'sam', voice_preset: 'catalog-voice-1' });
await assert.rejects(api.createAgent({ display_name: 'Sam', identity_id: 'sam' }), /voice_preset from the current voice catalog is required/);
await assert.rejects(api.createAgent({ display_name: 'Sam', identity_id: 'sam', voice_preset: '  ' }), /voice_preset from the current voice catalog is required/);
assert.equal(calls.length, 6);
assert.throws(() => new HarvestApi({ apiKey: ['hvst', 'live', 'wrong_scope'].join('_') }), /developer API key required/);

const unauthorized = new HarvestApi({
  apiKey: testKey,
  fetch: async () => ({ ok: false, status: 401, json: async () => ({ reason: 'unauthorized' }) }),
});
await assert.rejects(unauthorized.agents(), /Harvest API 401: unauthorized/);

const invalid = new HarvestApi({
  apiKey: testKey,
  fetch: async () => ({ ok: false, status: 400, json: async () => ({ reason: 'invalid_identity' }) }),
});
await assert.rejects(invalid.createAgent({ identity_id: 'missing', voice_preset: 'catalog-voice-1' }), /Harvest API 400: invalid_identity/);

const invalidVoice = new HarvestApi({
  apiKey: testKey,
  fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_request', message: 'voice_preset is not allowlisted' }) }),
});
await assert.rejects(invalidVoice.createAgent({ identity_id: 'cube', voice_preset: 'unknown' }), /Harvest API 400: voice_preset is not allowlisted/);

const limited = new HarvestApi({
  apiKey: testKey,
  fetch: async () => ({ ok: false, status: 429, headers: { get: () => '42' }, json: async () => ({ reason: 'rate_limited' }) }),
});
await assert.rejects(limited.agents(), { status: 429, retryAfterSeconds: 42, message: /rate_limited/ });

const offline = new HarvestApi({ apiKey: testKey, fetch: async () => { throw new Error('offline'); } });
await assert.rejects(offline.agents(), /offline/);

// Exercise the wire contract through the same HTTP transport consumers use.
const { createServer } = await import('node:http');
const received = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  received.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body });
  res.setHeader('Content-Type', 'application/json');
  if (req.url.includes('missing')) {
    res.writeHead(404);
    res.end(JSON.stringify({ reason: 'not_found' }));
    return;
  }
  const state = req.method === 'POST' ? 'scheduled' : req.method === 'DELETE' ? 'cancel_requested' : 'waiting_room';
  res.writeHead(req.method === 'GET' ? 200 : 202);
  res.end(JSON.stringify({ session: { session_id: 'session/2', state } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const local = new HarvestApi({ apiKey: testKey, baseUrl: `http://127.0.0.1:${server.address().port}` });
  const brief = {
    version: 1, goal: 'Review the saved plan', agenda: [], participants: [], constraints: [], recent_summary: '',
  };
  assert.equal((await local.join('agent/1', {
    meetingUrl: 'https://meet.google.com/abc-defg-hij', joinAt: '2030-01-01T12:00:00Z', lobbyTimeoutSeconds: 600, brief,
  })).session.state, 'scheduled');
  assert.deepEqual(received[0], {
    url: '/api/agents/agent%2F1/sessions', method: 'POST', authorization: 'Bearer hvst_dev_test',
    body: JSON.stringify({ meeting_url: 'https://meet.google.com/abc-defg-hij', join_at: '2030-01-01T12:00:00Z', lobby_timeout_s: 600, brief }),
  });
  assert.equal((await local.session('agent/1', 'session/2')).session.state, 'waiting_room');
  assert.equal(received[1].url, '/api/agents/agent%2F1/sessions/session%2F2');
  assert.equal(received[1].method, 'GET');
  assert.equal((await local.cancel('agent/1', 'session/2')).session.state, 'cancel_requested');
  assert.equal(received[2].url, '/api/agents/agent%2F1/sessions/session%2F2');
  assert.equal(received[2].method, 'DELETE');
  await local.join('agent/1', { meetingUrl: 'https://meet.google.com/abc-defg-hij' });
  assert.deepEqual(JSON.parse(received[3].body), { meeting_url: 'https://meet.google.com/abc-defg-hij' });
  await assert.rejects(local.cancel('agent/1', 'missing'), { status: 404, message: /not_found/ });
  assert.equal(received.length, 5, 'failed mutations are never automatically retried');
  await local.sessions('agent/1');
  assert.equal(received[5].url, '/api/agents/agent%2F1/sessions');
  assert.equal(received[5].method, 'GET');
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log('PASS API client: scheduled/immediate join, status, cancellation, encoded IDs, authenticated HTTP, no retry');
