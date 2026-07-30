import WebSocket from 'ws';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const SAFE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'range',
]);
const SAFE_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-type',
  'etag',
  'last-modified',
  'location',
]);

export async function openParticipantPageTunnel({
  mcpUrl,
  participantGatewayUrl = mcpUrl,
  token,
  port,
  fetchImpl = fetch,
  WebSocketImpl = WebSocket,
}) {
  assertPort(port);
  await probeLocalPort(port, fetchImpl);
  const controlUrl = new URL('/participant-pages', participantGatewayUrl);
  const response = await fetchImpl(controlUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`participant_page_create_failed_http_${response.status}`);
  const registration = await response.json();
  validateRegistration(registration);
  const page = new ParticipantPageTunnel({
    registration,
    controlUrl,
    token,
    port,
    fetchImpl,
    WebSocketImpl,
  });
  try {
    await page.connect();
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

class ParticipantPageTunnel {
  constructor({ registration, controlUrl, token, port, fetchImpl, WebSocketImpl }) {
    this.registration = registration;
    this.controlUrl = controlUrl;
    this.token = token;
    this.port = port;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.closed = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
  }

  get publicUrl() {
    return this.registration.page_url;
  }

  get expiresAt() {
    return this.registration.expires_at;
  }

  async connect() {
    if (this.closed) throw new Error('participant_page_closed');
    const socket = new this.WebSocketImpl(this.registration.page_ws_url, {
      headers: { Authorization: `Bearer ${this.registration.page_access_key}` },
    });
    this.socket = socket;
    await waitForOpen(socket);
    this.reconnectAttempt = 0;
    socket.on('message', (data) => { void this.handleMessage(data); });
    socket.once('close', () => this.scheduleReconnect(socket));
    socket.once('error', () => this.scheduleReconnect(socket));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.socket?.close(1000, 'client_closed'); } catch {}
    this.socket = null;
    await this.fetchImpl(new URL(
      `/participant-pages/${encodeURIComponent(this.registration.page_id)}`,
      this.controlUrl,
    ), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
  }

  scheduleReconnect(socket) {
    if (this.closed || this.socket !== socket || this.reconnectTimer) return;
    this.socket = null;
    const delays = [250, 500, 1000, 2000, 4000];
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect(this.socket));
    }, delay);
  }

  async handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (
      message?.type !== 'http.request'
      || typeof message.request_id !== 'string'
      || !['GET', 'HEAD', 'POST'].includes(message.method)
      || typeof message.path !== 'string'
      || !message.path.startsWith('/')
      || typeof message.body_base64 !== 'string'
    ) return;

    let result;
    try {
      result = await this.fetchLocal(
        message.method,
        message.path,
        message.headers,
        Buffer.from(message.body_base64, 'base64'),
      );
    } catch (error) {
      result = {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: Buffer.from(error instanceof Error ? error.message : 'local_request_failed'),
      };
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== this.WebSocketImpl.OPEN) return;
    socket.send(JSON.stringify({
      type: 'http.response',
      request_id: message.request_id,
      status: result.status,
      headers: result.headers,
      body_base64: result.body.toString('base64'),
    }));
  }

  async fetchLocal(method, path, headers, body) {
    const response = await this.fetchImpl(`http://127.0.0.1:${this.port}${path}`, {
      method,
      headers: filterHeaders(headers, SAFE_REQUEST_HEADERS),
      body: method === 'POST' ? body : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return {
      status: response.status,
      headers: filterResponseHeaders(Object.fromEntries(response.headers.entries())),
      body: method === 'HEAD' ? Buffer.alloc(0) : await readBoundedBody(response, MAX_RESPONSE_BYTES),
    };
  }
}

async function probeLocalPort(port, fetchImpl) {
  try {
    await fetchImpl(`http://127.0.0.1:${port}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    throw new Error(`local_port_unreachable_${port}`);
  }
}

async function waitForOpen(socket) {
  if (socket.readyState === socket.OPEN) return;
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => finish(() => reject(new Error('participant_page_connect_timeout'))),
      REQUEST_TIMEOUT_MS,
    );
    const onOpen = () => finish(resolvePromise);
    const onError = () => finish(() => reject(new Error('participant_page_connect_failed')));
    const onClose = () => finish(() => reject(new Error('participant_page_connect_closed')));
    const finish = (action) => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
      typeof action === 'function' ? action() : resolvePromise();
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function readBoundedBody(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error('local_response_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function filterHeaders(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([name, header]) => (
    allowed.has(name.toLowerCase()) && typeof header === 'string' && header.length <= 4096
      ? [[name.toLowerCase(), header]]
      : []
  )));
}

function filterResponseHeaders(value) {
  const headers = filterHeaders(value, SAFE_RESPONSE_HEADERS);
  if (headers.location && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(headers.location)) delete headers.location;
  return headers;
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('local_port_invalid');
  }
}

function validateRegistration(value) {
  if (
    !value
    || typeof value.page_id !== 'string'
    || typeof value.page_access_key !== 'string'
    || typeof value.page_url !== 'string'
    || typeof value.page_ws_url !== 'string'
    || typeof value.expires_at !== 'string'
  ) {
    throw new Error('participant_page_registration_invalid');
  }
}
