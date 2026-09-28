import assert from 'node:assert/strict';
import { HarvestApi } from './api-client.mjs';

const calls = [];
const testKey = ['hvst', 'dev', 'test'].join('_');
const api = new HarvestApi({
  apiKey: testKey,
  baseUrl: 'https://example.test/',
  fetch: async (url, init) => {
    calls.push({ url, ...init });
    return { ok: true, json: async () => ({ voices: [{ voice_preset: 'puck' }], identities: [] }) };
  },
});

assert.deepEqual(await api.voices(), [{ voice_preset: 'puck' }]);
assert.equal(calls[0].url, 'https://example.test/api/catalog/identities');
assert.equal(calls[0].headers.Authorization, 'Bearer hvst_dev_test');
await api.configureAgent('agent/1', { identity_id: 'cube', voice_preset: 'puck' });
assert.equal(calls[1].url, 'https://example.test/api/agents/agent%2F1/identity');
assert.equal(calls[1].method, 'PATCH');
assert.deepEqual(JSON.parse(calls[1].body), { identity_id: 'cube', voice_preset: 'puck' });
await api.agent('agent/2');
assert.equal(calls[2].url, 'https://example.test/api/agents/agent%2F2');
await api.revokeAgentToken('agent/2', 'cred/3');
assert.equal(calls[3].url, 'https://example.test/api/agents/agent%2F2/credentials/cred%2F3/revoke');
assert.throws(() => new HarvestApi({ apiKey: ['hvst', 'live', 'wrong_scope'].join('_') }), /developer API key required/);

const unauthorized = new HarvestApi({
  apiKey: testKey,
  fetch: async () => ({ ok: false, status: 401, json: async () => ({ reason: 'unauthorized' }) }),
});
await assert.rejects(unauthorized.agents(), /Harvest API 401: unauthorized/);

const offline = new HarvestApi({ apiKey: testKey, fetch: async () => { throw new Error('offline'); } });
await assert.rejects(offline.agents(), /offline/);
