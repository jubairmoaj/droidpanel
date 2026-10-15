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
import { HttpError, json, readJson, which } from './util.mjs';

const { version } = createRequire(import.meta.url)('../package.json');

export function createAgent({ port, origins, relay, log }) {
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
    features: ['tcp'],
  }));

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
    if (!['/bridge', '/tcp'].includes(u.pathname) || !allowedHosts.has(req.headers.host ?? '') || !origins.has(req.headers.origin ?? '')) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const ws = acceptWebSocket(req, socket);
    if (u.pathname === '/bridge') relay.attachBridge(ws);
    else tcpTunnel(ws, u.searchParams.get('host') ?? '', log);
  });

  return server;
}

/** Only phones on the local network: the panel must not be able to use the helper as a general proxy. */
function lanTarget(hostPort) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(hostPort);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  const port = Number(m[5]);
  if (m.slice(1, 5).some((x) => Number(x) > 255) || port < 1 || port > 65535) return null;
  const lan = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127); // 100.64/10: Tailscale/CGNAT
  return lan ? { host: m.slice(1, 5).join('.'), port } : null;
}

/**
 * Wi-Fi debugging for hosted mode: pipe a TCP connection to the phone's adbd (adb tcpip mode)
 * through a WebSocket. The browser speaks the ADB protocol itself (ui/src/core/adb/tcp.js).
 */
function tcpTunnel(ws, hostPort, log) {
  const target = lanTarget(hostPort);
  if (!target) {
    ws.send(JSON.stringify({ ok: false, error: `Not a local-network address: ${hostPort} (use the phone's Wi-Fi IP, e.g. 192.168.1.20:5555)` }));
    return ws.close();
  }
  const sock = net.connect(target);
  let open = false;
  sock.setTimeout(4000, () => sock.destroy(new Error('timed out')));
  sock.once('connect', () => {
    open = true;
    sock.setTimeout(0);
    sock.setNoDelay(true);
    ws.send(JSON.stringify({ ok: true }));
    log(`[wifi] connected to ${hostPort}`);
  });
  sock.on('data', (d) => ws.send(d));
  sock.on('error', (e) => {
    if (!open) {
      ws.send(JSON.stringify({ ok: false, error: `Can't reach ${hostPort} (${e.message}). Is the phone on the same Wi-Fi as this PC, `
        + 'with Wi-Fi debugging switched on? Some routers block device-to-device traffic (AP isolation).' }));
    }
  });
  sock.on('close', () => ws.close());
  ws.onMessage((data, isText) => { if (!isText) sock.write(data); });
  ws.onClose(() => sock.destroy());
}

/** Start the relay (fake adb server) and the agent. Every adb call from this process tree goes to the relay. */
export async function startAgent({ port, relayPort, origins, log = console.log }) {
  const relay = createRelay({ log: (l) => log(`[relay] ${l}`) });
  await new Promise((resolve, reject) => {
    relay.server.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE'
      ? `Port ${relayPort} is busy — is another droidpanel agent running? Use --relay-port`
      : e.message)));
    relay.server.listen(relayPort, '127.0.0.1', resolve);
  });
  process.env.ANDROID_ADB_SERVER_PORT = String(relayPort);
  const server = createAgent({ port, origins, relay, log });
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? `Port ${port} is busy — use --port` : e.message)));
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, relay, stop: stopAllJobs };
}
