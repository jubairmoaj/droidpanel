// Screen mirroring through scrcpy's device-side server.
//
// The scrcpy-server jar (shipped with any scrcpy install) is pushed to the phone and
// started over `adb shell`. Its raw H.264 stream is piped untouched to the browser,
// which decodes it with WebCodecs, so the PC does almost no work. Touch/keys go back
// over a WebSocket and are forwarded as scrcpy control messages to the control socket.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { adb, adbSpawn } from './adb.mjs';
import { exec, onLines, sleep, which } from './util.mjs';
import { SCRCPY_JAR, newScid, scrcpyArgs } from '../public/shared/device.js';

const SERVER_CANDIDATES = [
  process.env.SCRCPY_SERVER,
  path.join(os.homedir(), '.local/scrcpy/scrcpy-server'),
  '/usr/local/share/scrcpy/scrcpy-server',
  '/usr/share/scrcpy/scrcpy-server',
  '/opt/homebrew/share/scrcpy/scrcpy-server',
  '/snap/scrcpy/current/usr/share/scrcpy/scrcpy-server',
];

let cached = null;
/** Locate scrcpy-server and its version (the device server must match exactly). */
export async function scrcpyInfo() {
  if (cached) return cached;
  let server = SERVER_CANDIDATES.find((p) => p && existsSync(p));
  const bin = which('scrcpy');
  if (!server && bin) {
    const sibling = path.join(path.dirname(bin), 'scrcpy-server');
    if (existsSync(sibling)) server = sibling;
  }
  let version = process.env.SCRCPY_VERSION;
  if (!version && bin) version = (await exec(bin, ['--version'], { timeout: 5000 })).stdout.match(/scrcpy (\S+)/)?.[1];
  cached = { available: Boolean(server && version), server, version };
  return cached;
}

const sessions = new Map(); // serial -> session

export function stopMirror(serial, reason = 'stopped') {
  const s = sessions.get(serial);
  if (!s) return;
  sessions.delete(serial);
  s.log?.(`[mirror] ${serial}: ${reason}`);
  s.video?.destroy();
  s.control?.destroy();
  s.proc?.kill();
  for (const c of s.clients) c.close();
  adb(serial, ['forward', '--remove', `tcp:${s.port}`]);
}

export const stopAllMirrors = () => [...sessions.keys()].forEach((k) => stopMirror(k, 'shutdown'));

// adb forward accepts the TCP connection before the device server is listening, so we
// retry until the server's first "dummy" byte arrives.
function connectFirst(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const fail = () => { s.destroy(); resolve(null); };
    s.on('error', fail);
    s.on('close', fail);
    s.setTimeout(2000, fail);
    s.once('data', (buf) => {
      s.off('error', fail);
      s.off('close', fail);
      s.setTimeout(0);
      s.pause();
      resolve({ socket: s, rest: buf.subarray(1) });
    });
  });
}

function connectPlain(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => resolve(s));
    s.on('error', () => resolve(null));
  });
}

/** Start mirroring and pipe the video stream into an HTTP response. */
export async function streamMirror(serial, res, opts, log) {
  stopMirror(serial, 'replaced by a new session');
  const info = await scrcpyInfo();
  if (!info.available) {
    res.writeHead(501, { 'content-type': 'text/plain' }).end('scrcpy is not installed — using screenshot mode');
    return;
  }
  const scid = newScid();
  const s = { serial, port: 27200 + Math.floor(Math.random() * 2000), clients: new Set(), log };
  sessions.set(serial, s);
  const alive = () => sessions.get(serial) === s;
  res.on('close', () => { if (alive()) stopMirror(serial, 'viewer disconnected'); });

  const push = await adb(serial, ['push', info.server, SCRCPY_JAR], { timeout: 20000 });
  if (!push.ok) return fail(res, `push failed: ${push.stderr}`);
  const fwd = await adb(serial, ['forward', `tcp:${s.port}`, `localabstract:scrcpy_${scid}`]);
  if (!fwd.ok) return fail(res, `forward failed: ${fwd.stderr}`);

  s.proc = adbSpawn(serial, ['shell', ...scrcpyArgs(info.version, scid, opts)]);
  onLines(s.proc.stdout, (l) => l.trim() && log(`[mirror] ${l}`));
  onLines(s.proc.stderr, (l) => l.trim() && log(`[mirror] ${l}`));
  s.proc.on('close', (code) => { if (alive()) stopMirror(serial, `device server exited (${code})`); });

  let first = null;
  for (let i = 0; i < 60 && alive() && !first; i++) {
    first = await connectFirst(s.port);
    if (!first) await sleep(100);
  }
  if (!first || !alive()) {
    first?.socket.destroy();
    return fail(res, 'Could not connect to the device server');
  }
  s.video = first.socket;
  // The server accepts the control socket right after the video socket.
  s.control = await connectPlain(s.port);
  if (s.control) handleDeviceMessages(s);

  res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  if (first.rest.length) res.write(first.rest);
  s.video.pipe(res);
  s.video.on('close', () => { if (alive()) stopMirror(serial, 'video socket closed'); res.end(); });

  function fail(r, msg) {
    if (alive()) stopMirror(serial, msg);
    if (!r.headersSent) r.writeHead(502, { 'content-type': 'text/plain' }).end(msg);
  }
}

// Device → PC messages on the control socket. Only the clipboard is of interest.
function handleDeviceMessages(s) {
  let buf = Buffer.alloc(0);
  s.control.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length) {
      const type = buf[0];
      if (type === 0) { // clipboard: [type][u32 len][utf8]
        if (buf.length < 5) return;
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) return;
        const text = buf.subarray(5, 5 + len).toString('utf8');
        buf = buf.subarray(5 + len);
        for (const c of s.clients) c.send(JSON.stringify({ type: 'clipboard', text }));
      } else if (type === 1) { // ack clipboard: [type][u64 seq]
        if (buf.length < 9) return;
        buf = buf.subarray(9);
      } else {
        buf = Buffer.alloc(0); // unknown/uhid — drop
      }
    }
  });
  s.control.on('error', () => {});
}

/** Attach a browser WebSocket to a running session; binary messages go to the device as-is. */
export function attachControl(serial, ws) {
  const s = sessions.get(serial);
  if (!s?.control) {
    ws.send(JSON.stringify({ type: 'error', message: 'No mirror session' }));
    ws.close();
    return;
  }
  s.clients.add(ws);
  ws.onClose(() => s.clients.delete(ws));
  ws.onMessage((data, isText) => {
    if (!isText && data.length && data.length <= 70000) s.control.write(data);
  });
}

export const mirroring = (serial) => sessions.has(serial);
