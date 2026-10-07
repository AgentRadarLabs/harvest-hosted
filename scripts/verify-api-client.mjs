import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { HarvestApi, verifyWebhookSignature } from './api-client.mjs';

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
let roomEndRequests = 0;
const deliveryHistory = { deliveries: [{ id: 'delivery-1', endpoint: 'https://hooks.example.com/events',
  account_id: 'synthetic-account', subscription_id: 'wh/1', state: 'dead_letter', attempts: 5,
  created_at: 0, next_attempt_at: 15000, status: 503, last_error: 'http_503',
  envelope: { event: 'session.waiting_room', idempotency_key: 'operation-own:session.waiting_room',
    occurred_at: '2026-10-07T12:00:00.000Z', payload: { operation_id: 'operation-own', meeting_url: 'https://meet.google.com/abc-defg-hij' },
    signature: '3XKW4AMqiqv/SAD2WPj7eZMSVcGLws2laiGia8tS4sE=' },
}] };
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
  if (req.url === '/api/webhooks/wh%2F1/deliveries') {
    res.writeHead(200);
    res.end(JSON.stringify(deliveryHistory));
    return;
  }
  if (req.url === '/api/meetings/open') {
    const { join, agentId } = JSON.parse(body);
    res.writeHead(201);
    res.end(JSON.stringify({ room: { id: 'room/1', meeting_url: 'https://meet.google.com/abc-defg-hij',
      space_name: 'spaces/owned', access_type: 'OPEN', state: 'open' },
      ...(join ? agentId === 'unavailable' ? { join_error: 'unavailable' }
        : { session: { session_id: 'session/2', state: 'scheduled' } } : {}),
    }));
    return;
  }
  if (req.url === '/api/meetings/room%2F1') {
    roomEndRequests += 1;
    res.writeHead(roomEndRequests === 1 ? 202 : 200);
    res.end(JSON.stringify({ room: { id: 'room/1', state: roomEndRequests === 1 ? 'closing' : 'closed' } }));
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
  await local.artifacts('sess/1');
  assert.equal(received[6].url, '/api/sessions/sess%2F1/artifacts');
  await local.webhooks();
  assert.equal(received[7].url, '/api/webhooks');
  await local.createWebhook('https://hooks.example.com/events', ['session.waiting_room']);
  assert.deepEqual(JSON.parse(received[8].body), { endpoint: 'https://hooks.example.com/events', events: ['session.waiting_room'] });
  await local.deleteWebhook('wh/1');
  assert.equal(received[9].url, '/api/webhooks/wh%2F1');
  assert.equal(received[9].method, 'DELETE');
  assert.deepEqual(await local.webhookDeliveries('wh/1'), deliveryHistory);
  assert.equal(received[10].url, '/api/webhooks/wh%2F1/deliveries');
  assert.equal(received[10].method, 'GET');
  assert.equal(received[10].authorization, 'Bearer hvst_dev_test');
  await assert.rejects(local.webhookDeliveries('missing'), { status: 404, message: /not_found/ });
  assert.equal(received.length, 12, 'a history failure performs exactly one authenticated request');

  const created = await local.createMeeting();
  assert.equal(created.room.access_type, 'OPEN');
  assert.deepEqual(received[12], {
    url: '/api/meetings/open', method: 'POST', authorization: 'Bearer hvst_dev_test', body: '{}',
  });
  const joined = await local.createMeeting({ join: true, agentId: 'agent/1' });
  assert.equal(joined.session.state, 'scheduled', 'dispatch acceptance is not active admission');
  assert.deepEqual(JSON.parse(received[13].body), { join: true, agentId: 'agent/1' });
  const partial = await local.createMeeting({ join: true, agentId: 'unavailable' });
  assert.equal(partial.room.id, 'room/1', 'a join failure retains the created room');
  assert.equal(partial.join_error, 'unavailable');
  assert.equal((await local.endMeeting(created.room.id)).room.state, 'closing');
  assert.deepEqual(received[15], {
    url: '/api/meetings/room%2F1', method: 'DELETE', authorization: 'Bearer hvst_dev_test', body: '',
  });
  await assert.rejects(local.endMeeting('missing'), { status: 404, message: /not_found/ });
  assert.equal(received.length, 17, 'room mutations are never automatically retried');
  assert.equal((await local.endMeeting(created.room.id)).room.state, 'closed', 'only closed confirms cleanup');
  assert.equal(received.length, 18, 'cleanup is retried only when the caller explicitly requests it');

  // Fixed vector emitted by harvest-bot createSignedWebhook, not by the SDK helper under test.
  const signed = { event: 'session.waiting_room', idempotency_key: 'operation-own:session.waiting_room',
    occurred_at: '2026-10-07T12:00:00.000Z', payload: { operation_id: 'operation-own', meeting_url: 'https://meet.google.com/abc-defg-hij' },
    signature: '3XKW4AMqiqv/SAD2WPj7eZMSVcGLws2laiGia8tS4sE=' };
  assert.equal(verifyWebhookSignature(signed, 'secret'), true);
  assert.equal(verifyWebhookSignature({ ...signed, payload: { meeting_url: signed.payload.meeting_url, operation_id: 'operation-own' } }, 'secret'), true);
  assert.equal(verifyWebhookSignature(signed, 'other'), false);
  const nestedSigned = { event: 'chat.message', idempotency_key: 'chat-1', occurred_at: '2026-10-07T12:00:00.000Z',
    payload: { z: [{ b: 'quoted "value"', a: 'line\n' }], a: { z: 2, a: 1 } },
    signature: 'g8E3KTp+ZQzCR7R9dWIudg8TTFV2dsXVqPeQnftW+LM=' };
  assert.equal(verifyWebhookSignature(nestedSigned, 'secret'), true);
  assert.equal(verifyWebhookSignature({ ...nestedSigned, payload: { a: { a: 1, z: 2 }, z: [{ a: 'line\n', b: 'quoted "value"' }] } }, 'secret'), true);
  for (const altered of [ { ...signed, event: 'session.left' }, { ...signed, idempotency_key: 'another-event' },
    { ...signed, occurred_at: '2026-10-07T12:00:01.000Z' }, { ...signed, payload: { ...signed.payload, operation_id: 'foreign' } },
    { ...signed, signature: 'bad' }, { ...signed, signature: 'é'.repeat(44) },
  ]) assert.equal(verifyWebhookSignature(altered, 'secret'), false);
  for (const badKey of [ undefined, null, '', {}, 42 ]) assert.equal(verifyWebhookSignature(signed, badKey), false);
  for (const malformed of [ null, [], {}, { ...signed, signature: undefined }, { ...signed, event: null } ]) {
    assert.equal(verifyWebhookSignature(malformed, 'secret'), false);
  }
  const malformedSigned = { event: 'session.waiting_room', idempotency_key: 'k', occurred_at: 't', payload: null,
    signature: createHmac('sha256', 'secret').update('{"event":"session.waiting_room","idempotency_key":"k","occurred_at":"t","payload":null}').digest('base64') };
  assert.equal(verifyWebhookSignature(malformedSigned, 'secret'), false, 'a correctly signed malformed payload is still rejected');
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log('PASS API client: room creation/cleanup, scheduled/immediate join, status, cancellation, artifacts, webhooks/history, bot-compatible signatures, encoded IDs, authenticated HTTP, no retry');
