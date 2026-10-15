import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createReadStream, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as A from './adb.mjs';
import * as M from './mirror.mjs';
import * as P from './projects.mjs';
import { acceptWebSocket } from './ws.mjs';
import { HttpError, bodyToTempFile, exec, json, onLines, readJson, which } from './util.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.dart': 'text/plain; charset=utf-8', '.kt': 'text/plain; charset=utf-8',
};

// Small in-memory server log, shown in the UI's "Panel log".
const serverLog = [];
export function log(line) {
  serverLog.push(`${new Date().toLocaleTimeString()} ${line}`);
  if (serverLog.length > 500) serverLog.shift();
}

export function createApp({ port, host }) {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `${host}:${port}`]);

  // Defends against other websites driving the API from the user's browser:
  //  • Host must be ours (blocks DNS rebinding)
  //  • state-changing requests need a custom header, which forces a CORS preflight we never approve
  function guard(req) {
    if (!allowedHosts.has(req.headers.host ?? '')) throw new HttpError(403, 'Bad Host header');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-droidpanel'] !== '1') {
      throw new HttpError(403, 'Missing x-droidpanel header');
    }
  }

  const routes = new Map();
  const route = (method, p, fn) => routes.set(`${method} ${p}`, fn);
  const serialOf = (u, body) => {
    const s = body?.serial ?? u.searchParams.get('serial');
    if (!s) throw new HttpError(400, 'No device selected');
    return s;
  };

  // ── Devices & wireless ──
  route('GET', '/api/devices', async () => {
    const [d, scrcpy] = await Promise.all([A.listDevices(), M.scrcpyInfo()]);
    return { ...d, scrcpy: { available: scrcpy.available, version: scrcpy.version ?? null } };
  });
  route('GET', '/api/info', (u) => A.deviceInfo(serialOf(u)));
  route('POST', '/api/wireless/pair', (u, b) => A.pair(b.host, b.code));
  route('POST', '/api/wireless/connect', (u, b) => A.connect(b.host));
  route('POST', '/api/wireless/disconnect', (u, b) => A.disconnect(b.serial));
  route('POST', '/api/wireless/usb-to-wifi', (u, b) => A.usbToWifi(serialOf(u, b)));
  route('GET', '/api/wireless/mdns', () => A.mdnsServices());
  route('POST', '/api/wireless/qr', () => A.startQrPairing());
  route('GET', '/api/wireless/qr', () => A.qrStatus() ?? { status: 'idle' });

  // ── Dev toggles, input, reverse, deep links, shell ──
  route('GET', '/api/toggles', (u) => A.readToggles(serialOf(u)));
  route('POST', '/api/toggles', (u, b) => A.setToggle(serialOf(u, b), b.name, b.on));
  route('POST', '/api/input', async (u, b) => { await A.inputEvent(serialOf(u, b), b); return { ok: true }; });
  route('GET', '/api/reverse', (u) => A.reverseList(serialOf(u)));
  route('POST', '/api/reverse', (u, b) => (b.remove ? A.reverseRemove(serialOf(u, b), b.remove) : A.reverseAdd(serialOf(u, b), b.remote, b.local)));
  route('POST', '/api/open-url', (u, b) => A.openUrl(serialOf(u, b), b.url, b.pkg));
  route('POST', '/api/shell', (u, b) => A.runShell(serialOf(u, b), b.cmd));

  // ── Screenshot & recording ──
  route('POST', '/api/screenshot/copy', async (u, b) => {
    // Fallback when the browser refuses clipboard images: copy on the host instead.
    const png = await A.screenshot(serialOf(u, b));
    if (process.platform === 'darwin') {
      const file = path.join(os.tmpdir(), 'droidpanel-clip.png');
      await writeFile(file, png);
      const r = await exec('osascript', ['-e', `set the clipboard to (read (POSIX file "${file}") as «class PNGf»)`]);
      if (!r.ok) throw new HttpError(500, r.stderr);
      return { ok: true, via: 'osascript' };
    }
    const tool = which('wl-copy') ? ['wl-copy', ['--type', 'image/png']]
      : which('xclip') ? ['xclip', ['-selection', 'clipboard', '-t', 'image/png']]
        : null;
    if (!tool) throw new HttpError(501, 'No clipboard tool (install wl-clipboard or xclip)');
    await new Promise((resolve, reject) => {
      const p = spawn(tool[0], tool[1], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
      p.on('error', reject);
      p.stdin.end(png, resolve);
      p.unref();
    });
    return { ok: true, via: tool[0] };
  });
  route('POST', '/api/record/start', (u, b) => A.startRecording(serialOf(u, b), b));
  route('POST', '/api/record/stop', (u, b) => A.stopRecording(serialOf(u, b)));
  route('GET', '/api/record', (u) => A.recordingState(serialOf(u)));

  // ── Apps ──
  route('GET', '/api/apps', (u) => A.listPackages(serialOf(u), u.searchParams.get('all') === '1'));
  route('GET', '/api/app', (u) => A.appDetails(serialOf(u), u.searchParams.get('pkg')));
  route('POST', '/api/app', (u, b) => A.appAction(serialOf(u, b), b.pkg, b.action));
  route('POST', '/api/logcat/clear', async (u, b) => ({ ok: (await A.adb(serialOf(u, b), ['logcat', '-c'])).ok }));

  // ── Projects & jobs ──
  route('GET', '/api/projects', () => ({ projects: P.listProjects(), jobs: P.listJobs() }));
  route('POST', '/api/projects', (u, b) => P.addProject(String(b.path ?? '')));
  route('GET', '/api/projects/discover', () => P.discoverProjects());
  route('POST', '/api/projects/update', (u, b) => P.updateProject(b.id, b));
  route('POST', '/api/projects/remove', async (u, b) => { await P.removeProject(b.id); return { ok: true }; });
  route('POST', '/api/projects/run', (u, b) => P.startJob(b.id, b.task, b.serial));
  route('GET', '/api/jobs/log', (u) => P.jobLog(u.searchParams.get('id'), Number(u.searchParams.get('from') ?? 0)));
  route('POST', '/api/jobs/stop', (u, b) => { P.stopJob(b.id); return { ok: true }; });
  route('POST', '/api/jobs/input', (u, b) => { P.jobInput(b.id, String(b.data ?? '')); return { ok: true }; });

  route('GET', '/api/log', () => serverLog.slice(-200));
  route('GET', '/api/env', async () => ({
    adb: A.ADB,
    flutter: which('flutter'),
    scrcpy: await M.scrcpyInfo(),
    wlCopy: Boolean(which('wl-copy') || which('xclip')),
    platform: process.platform,
  }));

  // ── Streaming / binary endpoints (handled outside the JSON router) ──
  async function special(req, res, u) {
    const key = `${req.method} ${u.pathname}`;
    if (key === 'GET /api/mirror') {
      await M.streamMirror(serialOf(u), res, Object.fromEntries(u.searchParams), log);
      return true;
    }
    if (key === 'GET /api/screenshot') {
      const png = await A.screenshot(serialOf(u));
      const name = `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-disposition': `inline; filename="${name}"` });
      res.end(png);
      return true;
    }
    if (key === 'GET /api/record/file') {
      const file = A.recordingFile(u.searchParams.get('id'));
      if (!file) throw new HttpError(404, 'Recording not found');
      sendFile(res, file, 'video/mp4', `recording-${Date.now()}.mp4`);
      return true;
    }
    if (key === 'GET /api/app/apk') {
      const pkg = u.searchParams.get('pkg');
      sendFile(res, await A.pullApk(serialOf(u), pkg), 'application/vnd.android.package-archive', `${pkg}.apk`);
      return true;
    }
    if (key === 'POST /api/install') {
      const file = await bodyToTempFile(req, '.apk');
      json(res, 200, await A.installApk(serialOf(u), file));
      return true;
    }
    if (key === 'POST /api/push') {
      const file = await bodyToTempFile(req);
      json(res, 200, await A.pushFile(serialOf(u), file, u.searchParams.get('name')));
      return true;
    }
    if (key === 'GET /api/logcat') {
      streamLogcat(serialOf(u), req, res, u);
      return true;
    }
    if (key === 'GET /api/net') {
      streamNet(serialOf(u), req, res);
      return true;
    }
    return false;
  }

  function sendFile(res, file, type, name) {
    const size = statSync(file).size;
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'content-disposition': `attachment; filename="${name}"` });
    createReadStream(file).pipe(res);
  }

  // Logcat as Server-Sent Events, batched every 150 ms to keep the browser light.
  function streamLogcat(serial, req, res, u) {
    const tail = Math.min(5000, Math.max(0, Number(u.searchParams.get('tail') ?? 300) || 0));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': ok\n\n');
    const proc = A.adbSpawn(serial, ['logcat', '-v', 'threadtime', '-T', String(tail || 1)]);
    let batch = [];
    onLines(proc.stdout, (l) => batch.push(l));
    onLines(proc.stderr, (l) => batch.push(`--- ${l}`));
    const timer = setInterval(() => {
      if (!batch.length) return;
      res.write(`data: ${JSON.stringify(batch)}\n\n`);
      batch = [];
    }, 150);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    const end = () => { clearInterval(timer); clearInterval(ping); proc.kill(); };
    proc.on('close', () => { res.write('event: end\ndata: {}\n\n'); res.end(); end(); });
    req.on('close', end);
  }

  // Network inspector: apps print `DPNET|<key>|<i>|<n>|<json chunk>` lines to logcat
  // (see public/snippets). We reassemble the chunks and stream complete events as SSE.
  function streamNet(serial, req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': ok\n\n');
    const proc = A.adbSpawn(serial, ['logcat', '-v', 'raw', '-T', '5000', 'flutter:V', 'DPNET:V', '*:S']);
    const partial = new Map(); // key -> { n, parts, at }
    let batch = [];
    onLines(proc.stdout, (line) => {
      const at = line.indexOf('DPNET|');
      if (at < 0) return;
      const rest = line.slice(at + 6);
      const p1 = rest.indexOf('|'), p2 = rest.indexOf('|', p1 + 1), p3 = rest.indexOf('|', p2 + 1);
      if (p1 < 0 || p2 < 0 || p3 < 0) return;
      const key = rest.slice(0, p1);
      const i = Number(rest.slice(p1 + 1, p2)), n = Number(rest.slice(p2 + 1, p3));
      if (!(n > 0 && n <= 2000 && i >= 0 && i < n)) return;
      let e = partial.get(key);
      if (!e || e.n !== n) partial.set(key, (e = { n, parts: new Array(n), got: 0, at: Date.now() }));
      if (e.parts[i] === undefined) e.got++;
      e.parts[i] = rest.slice(p3 + 1);
      if (e.got < n) {
        if (partial.size > 300) partial.delete(partial.keys().next().value); // drop the oldest broken one
        return;
      }
      partial.delete(key);
      try { batch.push(JSON.parse(e.parts.join(''))); } catch { /* corrupted line */ }
    });
    const timer = setInterval(() => {
      if (!batch.length) return;
      res.write(`data: ${JSON.stringify(batch)}\n\n`);
      batch = [];
    }, 200);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    const end = () => { clearInterval(timer); clearInterval(ping); proc.kill(); };
    proc.on('close', () => { res.write('event: end\ndata: {}\n\n'); res.end(); end(); });
    req.on('close', end);
  }

  function serveStatic(req, res, u) {
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC)) throw new HttpError(403, 'Forbidden');
    let st;
    try { st = statSync(file); } catch { throw new HttpError(404, 'Not found'); }
    if (!st.isFile()) throw new HttpError(404, 'Not found');
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    createReadStream(file).pipe(res);
  }

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    try {
      guard(req);
      if (!u.pathname.startsWith('/api/')) return serveStatic(req, res, u);
      if (await special(req, res, u)) return;
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
    const origin = req.headers.origin ?? '';
    const okOrigin = [...allowedHosts].some((h) => origin === `http://${h}`);
    if (u.pathname !== '/api/mirror/control' || !allowedHosts.has(req.headers.host ?? '') || !okOrigin) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    M.attachControl(u.searchParams.get('serial') ?? '', acceptWebSocket(req, socket));
  });

  return server;
}

export async function shutdown() {
  M.stopAllMirrors();
  P.stopAllJobs();
}

