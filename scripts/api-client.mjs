const DEFAULT_URL = 'https://tryharvest.ai';

export class HarvestApi {
  constructor({ apiKey, baseUrl = DEFAULT_URL, fetch: request = globalThis.fetch }) {
    if (!apiKey?.startsWith('hvst_dev_')) throw new Error('Harvest developer API key required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = request;
  }

  async request(path, method = 'GET', body, headers = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`Harvest API ${response.status}: ${data?.message ?? data?.reason ?? data?.error ?? 'request failed'}`);
      error.status = response.status;
      const retryAfter = response.headers?.get?.('Retry-After');
      if (response.status === 429 && /^\d+$/.test(retryAfter ?? '')) error.retryAfterSeconds = Number(retryAfter);
      throw error;
    }
    return data;
  }

  catalog(filters = {}) {
    const query = new URLSearchParams();
    for (const field of ['locale', 'tag', 'gender']) {
      const value = filters[field];
      if (typeof value === 'string' && value.trim()) query.set(field, value.trim());
    }
    const suffix = query.toString();
    return this.request(`/api/catalog/identities${suffix ? `?${suffix}` : ''}`);
  }
  async voices(filters) { return (await this.catalog(filters)).voices; }
  async avatars() { return (await this.catalog()).identities; }
  agents() { return this.request('/api/agents'); }
  agent(id) { return this.request(`/api/agents/${encodeURIComponent(id)}`); }
  async createAgent(config, { idempotencyKey } = {}) {
    if (typeof config?.voice_preset !== 'string' || !config.voice_preset.trim()) {
      throw new TypeError('voice_preset from the current voice catalog is required');
    }
    return this.request('/api/agents', 'POST', config,
      idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey });
  }
  configureAgent(id, config) { return this.request(`/api/agents/${encodeURIComponent(id)}/identity`, 'PATCH', config); }
  join(agentId, { meetingUrl, joinAt, lobbyTimeoutSeconds, brief }) {
    return this.request(`/api/agents/${encodeURIComponent(agentId)}/sessions`, 'POST', {
      meeting_url: meetingUrl, join_at: joinAt, lobby_timeout_s: lobbyTimeoutSeconds, brief,
    });
  }
  session(agentId, sessionId) {
    return this.request(`/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`);
  }
  sessions(agentId) { return this.request(`/api/agents/${encodeURIComponent(agentId)}/sessions`); }
  cancel(agentId, sessionId) {
    return this.request(`/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`, 'DELETE');
  }
  issueAgentToken(id) { return this.request(`/api/agents/${encodeURIComponent(id)}/credentials`, 'POST'); }
  revokeAgentToken(id, credentialId) {
    return this.request(`/api/agents/${encodeURIComponent(id)}/credentials/${encodeURIComponent(credentialId)}/revoke`, 'POST');
  }
}
