// Talks to the local Node server, or, in hosted mode (`droidpanel --web`), to
// web/backend.js, which drives the phone from the browser over WebUSB.

const env = await fetch('/api/env', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}));

/** True in hosted mode: no local server, the browser talks to the phone itself. */
export const WEB = env.mode === 'web';
export const backend = WEB ? await import('./web/backend.js').then((m) => m.createBackend(env)) : null;
/** Hosted mode only: the PC helper that runs Build & Run (see web/agent.js). */
export const agent = backend ? (await import('./web/agent.js')).createAgent(backend) : null;
const AGENT_PATHS = /^\/api\/(projects|jobs)(\/|\?|$)/;

/** JSON API helper. POST when a body is given; throws Error(message) on failure. */
export async function api(path, { body, method, raw, headers } = {}) {
  if (agent && AGENT_PATHS.test(path)) return agent.api(path, { body, method });
  if (backend) return backend.api(path, { body, method });
  const init = { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers: { 'x-droidpanel': '1', ...headers } };
  if (body !== undefined) {
    if (raw) init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
  }
  const res = await fetch(path, init);
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error ?? data ?? res.statusText);
  return data;
}

/** fetch() for binary/streaming endpoints (screenshot, mirror, APK download). */
export const apiFetch = (path, init) => (backend ? backend.fetch(path, init) : fetch(path, init));

/** EventSource for logcat / network streams. */
export const apiEvents = (path) => (backend ? backend.events(path) : new EventSource(path));

/** WebSocket carrying scrcpy control messages for a running mirror. */
export function apiControl(serial) {
  if (backend) return backend.control(serial);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/mirror/control?serial=${encodeURIComponent(serial)}`);
  ws.binaryType = 'arraybuffer';
  return ws;
}
