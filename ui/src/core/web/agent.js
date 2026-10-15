// Hosted mode ⇄ PC helper (`droidpanel agent`, src/agent.mjs).
//  • Build & Run calls (/api/projects, /api/jobs) go to the agent's HTTP API.
//  • A WebSocket "bridge" lets the agent's adb (used by flutter/gradle) reach the phone
//    through this page's WebUSB connection: the agent asks to open a service, we open it
//    on the phone and pipe bytes both ways. Frames: [type u8][stream id u32 BE][payload].

const F = { OPEN: 1, OK: 2, FAIL: 3, DATA: 4, CLOSE: 5 };
const enc = new TextEncoder();
const dec = new TextDecoder();
const STORE = { url: 'droidpanel.agentUrl', enabled: 'droidpanel.agentEnabled' };

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function frame(type, id, payload = new Uint8Array(0)) {
  const b = new Uint8Array(5 + payload.length);
  b[0] = type;
  new DataView(b.buffer).setUint32(1, id);
  b.set(payload, 5);
  return b;
}

export function createAgent(backend) {
  const base = () => store.get(STORE.url, 'http://127.0.0.1:4322').replace(/\/$/, '');
  const listeners = new Set();
  let ws = null;
  let connected = false;
  let retry = null;
  let delay = 2000;
  const streams = new Map(); // id -> AdbSocket

  const setConnected = (on) => {
    if (connected === on) return;
    connected = on;
    listeners.forEach((fn) => fn(on));
  };

  async function api(path, { body, method } = {}) {
    let res;
    try {
      res = await fetch(base() + path, {
        method: method ?? (body !== undefined ? 'POST' : 'GET'),
        headers: { 'content-type': 'application/json', 'x-droidpanel': '1' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('PC helper is not running — start it with the command in Build & Run');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    return data;
  }

  function sendDevices() {
    if (ws?.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'devices', devices: backend.deviceList() }));
  }

  async function openStream(id, { serial, service }) {
    let sock;
    try {
      sock = await backend.adbFor(serial).open(service);
    } catch (e) {
      ws?.send(frame(F.FAIL, id, enc.encode(e.message || 'closed')));
      return;
    }
    if (ws?.readyState !== 1) return sock.close();
    streams.set(id, sock);
    ws.send(frame(F.OK, id));
    for (let c; (c = await sock.read());) {
      if (ws?.readyState !== 1) break;
      ws.send(frame(F.DATA, id, c));
    }
    if (streams.get(id) === sock) {
      streams.delete(id);
      ws?.send(frame(F.CLOSE, id));
    }
  }

  function onFrame(buf) {
    const b = new Uint8Array(buf);
    if (b.length < 5) return;
    const id = new DataView(b.buffer).getUint32(1);
    const payload = b.subarray(5);
    if (b[0] === F.OPEN) {
      let req;
      try { req = JSON.parse(dec.decode(payload)); } catch { return; }
      openStream(id, req);
    } else if (b[0] === F.DATA) {
      streams.get(id)?.write(payload.slice()).catch(() => {});
    } else if (b[0] === F.CLOSE) {
      const s = streams.get(id);
      streams.delete(id);
      s?.close();
    }
  }

  function connect() {
    clearTimeout(retry);
    if (ws && ws.readyState <= 1) return;
    store.set(STORE.enabled, '1');
    const sock = new WebSocket(`${base().replace(/^http/, 'ws')}/bridge`);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onopen = () => {
      delay = 2000;
      setConnected(true);
      sendDevices();
    };
    sock.onmessage = (e) => { if (typeof e.data !== 'string') onFrame(e.data); };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      for (const s of streams.values()) s.close();
      streams.clear();
      setConnected(false);
      retry = setTimeout(connect, delay); // the agent may be restarted; reconnect quietly
      delay = Math.min(30000, delay * 2);
    };
  }

  backend.onChange(sendDevices);
  // Only auto-connect once the user has set the helper up (avoids a permission prompt for everyone).
  if (store.get(STORE.enabled, '') === '1') connect();

  return {
    api,
    connect,
    get connected() { return connected; },
    get url() { return base(); },
    setUrl(u) { store.set(STORE.url, u); ws?.close(); },
    /** WebSocket URL that the helper turns into a TCP connection to host:port (Wi-Fi debugging). */
    tcpUrl: (host) => `${base().replace(/^http/, 'ws')}/tcp?host=${encodeURIComponent(host)}`,
    onChange: (fn) => listeners.add(fn),
    status: () => api('/api/agent'),
  };
}
