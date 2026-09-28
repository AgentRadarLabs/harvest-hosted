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
assert.throws(() => new HarvestApi({ apiKey: ['hvst', 'live', 'wrong_scope'].join('_') }), /developer API key required/);
