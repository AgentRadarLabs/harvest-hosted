import assert from 'node:assert/strict';
import { HarvestApi } from './api-client.mjs';

const calls = [];
const testKey = ['hvst', 'dev', 'test'].join('_');
const api = new HarvestApi({
  apiKey: testKey,
  baseUrl: 'https://example.test/',
  fetch: async (url, init) => {
    calls.push({ url, ...init });
    return { ok: true, json: async () => ({ voices: [{ voice_preset: 'ru-RU-Chirp3-HD-Kore', provider: 'google' }], identities: [] }) };
  },
});

assert.deepEqual(await api.voices(), [{ voice_preset: 'ru-RU-Chirp3-HD-Kore', provider: 'google' }]);
assert.equal(calls[0].url, 'https://example.test/api/catalog/identities');
assert.equal(calls[0].headers.Authorization, 'Bearer hvst_dev_test');
await api.configureAgent('agent/1', { identity_id: 'cube', voice_preset: 'ru-RU-Chirp3-HD-Kore' });
assert.equal(calls[1].url, 'https://example.test/api/agents/agent%2F1/identity');
assert.equal(calls[1].method, 'PATCH');
assert.deepEqual(JSON.parse(calls[1].body), { identity_id: 'cube', voice_preset: 'ru-RU-Chirp3-HD-Kore' });
await api.agent('agent/2');
assert.equal(calls[2].url, 'https://example.test/api/agents/agent%2F2');
await api.revokeAgentToken('agent/2', 'cred/3');
assert.equal(calls[3].url, 'https://example.test/api/agents/agent%2F2/credentials/cred%2F3/revoke');
assert.deepEqual(await api.voices({ locale: 'ru-RU', tag: 'chirp3-hd', gender: 'female', ignored: 'x' }), [{ voice_preset: 'ru-RU-Chirp3-HD-Kore', provider: 'google' }]);
assert.equal(calls[4].url, 'https://example.test/api/catalog/identities?locale=ru-RU&tag=chirp3-hd&gender=female');
assert.equal(calls[4].headers.Authorization, 'Bearer hvst_dev_test');
await api.createAgent({ display_name: 'Sam', identity_id: 'sam', voice_preset: 'ru-RU-Chirp3-HD-Kore' }, { idempotencyKey: 'request-1' });
assert.equal(calls[5].headers['Idempotency-Key'], 'request-1');
assert.deepEqual(JSON.parse(calls[5].body), { display_name: 'Sam', identity_id: 'sam', voice_preset: 'ru-RU-Chirp3-HD-Kore' });
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
await assert.rejects(invalid.createAgent({ identity_id: 'missing', voice_preset: 'ru-RU-Chirp3-HD-Kore' }), /Harvest API 400: invalid_identity/);

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
