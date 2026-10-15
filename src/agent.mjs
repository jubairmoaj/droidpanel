// PC helper for hosted mode (`droidpanel agent`): runs Build & Run tasks (flutter/gradle)
// on this PC when you click them in the hosted page. It idles until asked.
//
// Only pages from the allowed origins (--origin) may call it; it listens on 127.0.0.1 only
// and checks the Host header (DNS rebinding). Device access goes through the browser:
// see relay.mjs.
import { createServer } from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { projectRoutes } from './project-routes.mjs';
import { stopAllJobs } from './projects.mjs';
import { createRelay } from './relay.mjs';
import { acceptWebSocket } from './ws.mjs';
import { HttpError, exec, json, readJson, which } from './util.mjs';
import * as A from './adb.mjs';

const { version } = createRequire(import.meta.url)('../package.json');

// ── Wi-Fi debugging ─────────────────────────────────────────────────────────
// A private adb server with USB disabled owns Wi-Fi phones (pairing with QR/code, TLS, tcpip).
// It can never grab the phone's USB from the browser. The browser reaches its phones through
// /adb streams, and the relay lists them too, so flutter/gradle work over Wi-Fi.

function wifiServer(wifiPort) {
  const env = { ANDROID_ADB_SERVER_PORT: String(wifiPort), ADB_USB: '0', ADB_EMU: '0' };
  A.useWirelessServer(env);
  const adbCmd = (args, opts) => exec(A.ADB, args, { ...opts, env: { ...process.env, ...env } });
  const features = new Map(); // serial -> string[]

  /** Smart-socket request to the private server; resolves with the socket after OKAY. */
  function request(socket, req) {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const onData = (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length < 4) return;
        const status = buf.subarray(0, 4).toString();
        if (status === 'OKAY') {
          socket.off('data', onData);
          const rest = buf.subarray(4);
          if (rest.length) socket.unshift(rest);
          return resolve(socket);
        }
        if (buf.length < 8) return;
        const len = parseInt(buf.subarray(4, 8).toString(), 16);
        if (buf.length < 8 + len) return;
        socket.off('data', onData);
        reject(new Error(buf.subarray(8, 8 + len).toString() || 'adb request failed'));
      };
      socket.on('data', onData);
      socket.once('error', reject);
      socket.write(`${Buffer.byteLength(req).toString(16).padStart(4, '0')}${req}`);
    });
  }

  /** Open `service` on a Wi-Fi phone; resolves with a raw TCP socket to it. */
  async function open(serial, service) {
    const socket = net.connect(wifiPort, '127.0.0.1');
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    try {
      await request(socket, `host:transport:${serial}`);
      await request(socket, service);
      return socket;
    } catch (e) {
      socket.destroy();
      throw e;
    }
  }

  async function devices() {
    const { devices: list } = await A.listDevices();
    for (const d of list) {
      if (d.state !== 'device' || features.has(d.serial)) continue;
      const r = await adbCmd(['-s', d.serial, 'features'], { timeout: 5000 });
      features.set(d.serial, r.ok ? r.stdout.trim().split(/\s*\n\s*/).filter(Boolean) : []);
    }
    return list.map((d) => ({ ...d, transport: 'wifi', features: features.get(d.serial) ?? [] }));
  }

  const start = () => adbCmd(['start-server'], { timeout: 10000 });
  return { start, open, devices, forget: (serial) => features.delete(serial) };
}

export function createAgent({ port, origins, relay, wifi, log }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const routes = new Map();
  const route = (method, p, fn) => routes.set(`${method} ${p}`, fn);
  projectRoutes(route);
  route('GET', '/api/agent', () => ({
    ok: true,
    version,
    flutter: which('flutter'),
    adb: which(process.env.ADB || 'adb'),
    platform: process.platform,
    browserConnected: relay.connected,
    features: ['wifi'],
  }));
  route('GET', '/api/wifi/devices', () => wifi.devices());
  route('GET', '/api/wifi/mdns', () => A.mdnsServices());
  route('POST', '/api/wifi/pair', (u, b) => A.pair(b.host, b.code));
  route('POST', '/api/wifi/connect', (u, b) => A.connect(b.host));
  route('POST', '/api/wifi/disconnect', (u, b) => { wifi.forget(b.serial); return A.disconnect(b.serial); });
  route('POST', '/api/wifi/qr', () => A.startQrPairing());
  route('GET', '/api/wifi/qr', () => A.qrStatus() ?? { status: 'idle' });

  function cors(req, res) {
    const origin = req.headers.origin ?? '';
    if (!origins.has(origin)) return false;
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-methods', 'GET, POST');
    res.setHeader('access-control-allow-headers', 'content-type, x-droidpanel');
    res.setHeader('access-control-allow-private-network', 'true'); // Chrome private network access
    res.setHeader('access-control-max-age', '600');
    return true;
  }

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) throw new HttpError(403, 'Bad Host header');
      if (!cors(req, res)) throw new HttpError(403, `Origin not allowed: ${req.headers.origin ?? '(none)'} — restart the agent with --origin <your panel URL>`);
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      const fn = routes.get(`${req.method} ${u.pathname}`);
      if (!fn) throw new HttpError(404, 'No such endpoint');
      const body = req.method === 'POST' ? await readJson(req) : {};
      json(res, 200, (await fn(u, body)) ?? { ok: true });
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) log(`[error] ${req.method} ${u.pathname}: ${e.message}`);
      if (!res.headersSent) json(res, status, { error: e.message });
      else res.end();
    }
  });

  server.on('upgrade', (req, socket) => {
    const u = new URL(req.url, 'http://localhost');
    if (!['/bridge', '/adb'].includes(u.pathname) || !allowedHosts.has(req.headers.host ?? '') || !origins.has(req.headers.origin ?? '')) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const ws = acceptWebSocket(req, socket);
    if (u.pathname === '/bridge') return relay.attachBridge(ws);
    // One adb service stream to a Wi-Fi phone: first a JSON status message, then raw bytes.
    wifi.open(u.searchParams.get('serial') ?? '', u.searchParams.get('service') ?? '').then((s) => {
      ws.send(JSON.stringify({ ok: true }));
      s.on('data', (d) => ws.send(d));
      s.on('close', () => ws.close());
      s.on('error', () => {});
      ws.onMessage((data, isText) => { if (!isText) s.write(data); });
      ws.onClose(() => s.destroy());
    }, (e) => {
      ws.send(JSON.stringify({ ok: false, error: e.message }));
      ws.close();
    });
  });

  return server;
}

/** Start the relay (fake adb server) and the agent. Every adb call from this process tree goes to the relay. */
export async function startAgent({ port, relayPort, wifiPort = 5039, origins, log = console.log }) {
  const wifi = wifiServer(wifiPort);
  const relay = createRelay({ log: (l) => log(`[relay] ${l}`), external: wifi });
  await new Promise((resolve, reject) => {
    relay.server.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE'
      ? `Port ${relayPort} is busy — is another droidpanel agent running? Use --relay-port`
      : e.message)));
    relay.server.listen(relayPort, '127.0.0.1', resolve);
  });
  process.env.ANDROID_ADB_SERVER_PORT = String(relayPort);
  const started = await wifi.start();
  if (!started.ok) log(`Wi-Fi debugging unavailable: ${started.stderr || started.error}`);
  // Keep the relay's view of Wi-Fi phones fresh while a panel is connected.
  setInterval(() => { if (relay.connected) wifi.devices().then(relay.setExternal, () => {}); }, 2500).unref();
  const server = createAgent({ port, origins, relay, wifi, log });
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? `Port ${port} is busy — use --port` : e.message)));
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, relay, stop: stopAllJobs };
}
