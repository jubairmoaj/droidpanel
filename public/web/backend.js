// Hosted mode: the browser itself talks to the phone over WebUSB, so nothing runs on the
// laptop except this tab. This module answers the same /api/* calls as the local Node
// server (src/server.mjs), so app.js and mirror.js work unchanged.
import { Adb } from '../adb/adb.js';
import { browserKey } from '../adb/rsa.js';
import { ADB_FILTER, UsbTransport, findAdbInterface } from '../adb/webusb.js';
import * as D from '../shared/device.js';

const dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const merged = (r) => [r.stdout, r.stderr].map((s) => (s ?? '').trim()).filter(Boolean).join('\n');

class HttpError extends Error {}

/** Split a byte stream into lines. */
function lineSplitter(fn) {
  const td = new TextDecoder();
  let rest = '';
  return (bytes) => {
    const parts = (rest + td.decode(bytes, { stream: true })).split(/\r?\n/);
    rest = parts.pop();
    for (const p of parts) fn(p);
  };
}

/** Looks like an EventSource to app.js: onmessage / onerror / 'end' event / close(). */
class StreamEvents extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.onmessage = null;
    this.onerror = null;
  }
  emit(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  end() {
    if (this.readyState === 2) return;
    this.readyState = 2;
    this.dispatchEvent(new Event('end'));
  }
  close() {
    this.readyState = 2;
    this.onClose?.();
  }
}

export async function createBackend(env) {
  const scrcpy = env.scrcpy ?? { available: false };
  const devices = new Map(); // serial -> { serial, usb, adb, state, model, error }
  const logLines = [];
  const listeners = new Set();
  let key = null;
  let scrcpyJar = null;

  const log = (line) => {
    logLines.push(`${new Date().toLocaleTimeString()} ${line}`);
    if (logLines.length > 500) logLines.shift();
  };
  const changed = () => listeners.forEach((fn) => fn());

  const serialOf = (d) => d.serialNumber || `usb-${d.vendorId.toString(16)}-${d.productId.toString(16)}`;

  // ── Device lifecycle ──────────────────────────────────────────────────────

  async function attach(usb, attempt = 0) {
    if (!findAdbInterface(usb)) return;
    const serial = serialOf(usb);
    const prev = devices.get(serial);
    if (prev?.adb && !prev.adb.closed && prev.usb === usb) return;
    if (prev?.connecting && prev.usb === usb) return;
    const e = { serial, usb, adb: null, state: 'connecting', model: usb.productName ?? '', product: '', error: null, connecting: true };
    devices.set(serial, e);
    changed();
    try {
      key ??= await browserKey();
      const transport = await UsbTransport.open(usb);
      e.adb = await Adb.connect(transport, key, {
        onPrompt: () => {
          e.state = 'unauthorized';
          log(`${serial}: waiting for "Allow USB debugging" on the phone`);
          changed();
        },
      });
      Object.assign(e, { state: 'device', model: e.adb.model || e.model, product: e.adb.product, connecting: false });
      log(`${serial}: connected (${e.model})`);
      e.adb.disconnected.then((reason) => {
        if (devices.get(serial) !== e) return;
        stopMirror(serial);
        stopRecordingState(serial);
        e.adb = null;
        e.state = 'offline';
        log(`${serial}: disconnected${reason?.message && reason.message !== 'closed' ? ` (${reason.message})` : ''}`);
        changed();
      });
    } catch (err) {
      e.connecting = false;
      if (devices.get(serial) !== e) return;
      log(`${serial}: ${err.message}`);
      // After an unclean exit (page reload mid-stream) adbd may reset its USB function once;
      // the phone re-enumerates and the 'connect' event retries, but retry here too in case it doesn't.
      if (attempt < 2 && !/busy|no ADB interface/.test(err.message)) {
        e.state = 'connecting';
        changed();
        await sleep(1500);
        if (devices.get(serial) === e) return attach(usb, attempt + 1);
        return;
      }
      e.state = 'offline';
      e.error = err.message;
    }
    changed();
  }

  function detach(usb) {
    const serial = serialOf(usb);
    const e = devices.get(serial);
    if (!e || e.usb !== usb) return;
    e.adb?.close();
    devices.delete(serial);
    changed();
  }

  if (navigator.usb) {
    navigator.usb.addEventListener('connect', (ev) => attach(ev.device));
    navigator.usb.addEventListener('disconnect', (ev) => detach(ev.device));
    for (const d of await navigator.usb.getDevices()) attach(d);
    // Release the USB interface on reload/close so the next page can claim it cleanly.
    addEventListener('pagehide', () => devices.forEach((e) => e.adb?.close()));
  }

  /** Ask the user to pick a phone (needs a click). Resolves with its serial once connected. */
  async function requestDevice() {
    if (!navigator.usb) throw new Error('This browser has no WebUSB. Use Chrome, Edge or Brave on a computer.');
    const usb = await navigator.usb.requestDevice({ filters: [ADB_FILTER] });
    const serial = serialOf(usb);
    const e = devices.get(serial);
    if (e?.state === 'offline' || e?.error) devices.delete(serial);
    await attach(usb);
    return serial;
  }

  function adbOf(serial) {
    const e = devices.get(serial ?? '');
    if (!e) throw new HttpError('No device selected');
    if (!e.adb) throw new HttpError(e.state === 'unauthorized' ? 'Accept "Allow USB debugging" on the phone' : 'Device is not connected');
    return e.adb;
  }

  const sh = async (serial, cmd) => adbOf(serial).shell(cmd);
  const out = async (serial, cmd) => (await sh(serial, cmd)).stdout;

  const sizes = new WeakMap(); // adb -> [w, h]
  async function screenSize(serial) {
    const adb = adbOf(serial);
    if (!sizes.has(adb)) sizes.set(adb, D.parseScreenSize(await out(serial, 'wm size')));
    return sizes.get(adb);
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  const recordings = new Map(); // serial -> { proc, remote, startedAt, done }
  function stopRecordingState(serial) { recordings.delete(serial); }

  async function startRecording(serial, { bitrate = 8 } = {}) {
    if (recordings.get(serial)) throw new HttpError('Already recording');
    const remote = `/sdcard/droidpanel-${Date.now()}.mp4`;
    const proc = await adbOf(serial).spawn(`screenrecord --bit-rate ${D.intIn(bitrate, 1, 40, 8) * 1_000_000} ${remote}`);
    const rec = { proc, remote, startedAt: Date.now(), done: false };
    proc.exit.then(() => { rec.done = true; });
    recordings.set(serial, rec);
    return { startedAt: rec.startedAt };
  }

  async function stopRecording(serial) {
    const rec = recordings.get(serial);
    if (!rec) throw new HttpError('Not recording');
    if (!rec.done) await sh(serial, 'pkill -INT screenrecord');
    await Promise.race([rec.proc.exit, sleep(5000)]);
    await sleep(700); // let the mp4 finish writing
    recordings.delete(serial);
    const blob = await adbOf(serial).pull(rec.remote, 'video/mp4');
    await sh(serial, `rm -f ${D.q(rec.remote)}`);
    return { file: URL.createObjectURL(blob) };
  }

  // ── Mirror ────────────────────────────────────────────────────────────────

  const mirrors = new Map(); // serial -> { proc, video, control, clients }

  function stopMirror(serial) {
    const m = mirrors.get(serial);
    if (!m) return;
    mirrors.delete(serial);
    m.video?.close();
    m.control?.close();
    m.proc?.socket.close();
    for (const c of m.clients) c.close();
  }

  async function startMirror(serial, params) {
    stopMirror(serial);
    if (!scrcpy.available) throw new HttpError('scrcpy-server is not available on this host — using screenshot mode');
    const adb = adbOf(serial);
    const m = { clients: new Set() };
    mirrors.set(serial, m);
    const alive = () => mirrors.get(serial) === m;

    if (!adb.scrcpyPushed) {
      scrcpyJar ??= fetch('scrcpy-server', { cache: 'force-cache' }).then((r) => {
        if (!r.ok) throw new Error(`Could not download scrcpy-server (${r.status})`);
        return r.arrayBuffer();
      }).catch((e) => { scrcpyJar = null; throw e; });
      await adb.push(D.SCRCPY_JAR, new Uint8Array(await scrcpyJar));
      adb.scrcpyPushed = true;
    }
    const scid = D.newScid();
    const onLog = lineSplitter((l) => l.trim() && log(`[mirror] ${l}`));
    m.proc = await adb.spawn(D.scrcpyArgs(scrcpy.version, scid, params).join(' '), { onStdout: onLog, onStderr: onLog });
    let exited = false;
    m.proc.exit.then(() => { exited = true; if (alive()) stopMirror(serial); });

    for (let i = 0; i < 60 && alive() && !exited && !m.video; i++) {
      try { m.video = await adb.open(`localabstract:scrcpy_${scid}`); } catch { await sleep(100); }
    }
    if (!m.video || !alive()) {
      stopMirror(serial);
      throw new HttpError('Could not connect to the device server');
    }
    m.control = await adb.open(`localabstract:scrcpy_${scid}`);
    readDeviceMessages(m);

    const video = m.video;
    let first = true;
    const body = new ReadableStream({
      pull: async (ctl) => {
        let c = await video.read();
        if (c && first) { first = false; c = c.subarray(1); } // dummy byte sent on connect
        if (c === null) { ctl.close(); if (alive()) stopMirror(serial); } else if (c.length) ctl.enqueue(c);
      },
      cancel: () => { if (alive()) stopMirror(serial); },
    });
    return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
  }

  // Device → browser messages on the control socket; only the clipboard matters.
  async function readDeviceMessages(m) {
    let buf = new Uint8Array(0);
    for (let c; (c = await m.control.read());) {
      const b = new Uint8Array(buf.length + c.length);
      b.set(buf);
      b.set(c, buf.length);
      buf = b;
      while (buf.length) {
        if (buf[0] === 0) { // clipboard: [type][u32 len][utf8]
          if (buf.length < 5) break;
          const len = new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0);
          if (buf.length < 5 + len) break;
          const text = dec.decode(buf.subarray(5, 5 + len));
          buf = buf.subarray(5 + len);
          for (const cl of m.clients) cl.onmessage?.({ data: JSON.stringify({ type: 'clipboard', text }) });
        } else if (buf[0] === 1) { // ack clipboard: [type][u64 seq]
          if (buf.length < 9) break;
          buf = buf.subarray(9);
        } else buf = new Uint8Array(0); // unknown/uhid — drop
      }
    }
  }

  /** Looks like the mirror's control WebSocket to mirror.js. */
  function control(serial) {
    const m = mirrors.get(serial);
    const ws = {
      readyState: m?.control ? 1 : 3,
      binaryType: 'arraybuffer',
      onmessage: null,
      send(data) {
        if (ws.readyState !== 1 || !m.control || m.control.closed) return;
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (bytes.length && bytes.length <= 70000) m.control.write(bytes.slice()).catch(() => {});
      },
      close() {
        ws.readyState = 3;
        m?.clients.delete(ws);
      },
    };
    m?.clients.add(ws);
    return ws;
  }

  // ── Streams (logcat, network) ─────────────────────────────────────────────

  function events(path) {
    const u = new URL(path, location.origin);
    const ev = new StreamEvents();
    let batch = [];
    let proc = null;
    const timer = setInterval(() => {
      if (!batch.length) return;
      ev.emit(batch);
      batch = [];
    }, 150);
    const finish = () => {
      clearInterval(timer);
      proc?.socket.close();
    };
    ev.onClose = finish;
    (async () => {
      const adb = adbOf(u.searchParams.get('serial'));
      if (u.pathname === '/api/logcat') {
        const tail = Math.min(5000, Math.max(0, Number(u.searchParams.get('tail') ?? 300) || 0));
        proc = await adb.spawn(D.logcatArgs(tail).join(' '), {
          onStdout: lineSplitter((l) => batch.push(l)),
          onStderr: lineSplitter((l) => batch.push(`--- ${l}`)),
        });
      } else if (u.pathname === '/api/net') {
        const feed = D.netAssembler();
        proc = await adb.spawn(D.NET_LOGCAT_ARGS.map((a) => (a.includes('*') ? D.q(a) : a)).join(' '), {
          onStdout: lineSplitter((l) => {
            const e = feed(l);
            if (e) batch.push(e);
          }),
        });
      } else throw new Error(`No stream ${u.pathname}`);
      if (ev.readyState === 2) return finish();
      ev.readyState = 1;
      await proc.exit;
      if (batch.length) ev.emit(batch);
      clearInterval(timer);
      ev.end();
    })().catch((e) => {
      log(`[stream] ${e.message}`);
      clearInterval(timer);
      ev.readyState = 2;
      ev.onerror?.(e);
      ev.end();
    });
    return ev;
  }

  // ── JSON routes (same shapes as src/server.mjs) ───────────────────────────

  const routes = new Map();
  const route = (method, p, fn) => routes.set(`${method} ${p}`, fn);
  const s = (u, b) => b?.serial ?? u.searchParams.get('serial');
  const notHere = (what) => () => { throw new HttpError(`${what} is not available in hosted mode (it needs the desktop app)`); };

  route('GET', '/api/devices', () => ({
    adb: Boolean(navigator.usb),
    hint: navigator.usb ? null : window.isSecureContext
      ? 'This browser has no WebUSB — use Chrome, Edge or Brave on a computer'
      : 'WebUSB needs HTTPS — open this page over https://',
    devices: [...devices.values()].map((e) => ({
      serial: e.serial, state: e.state, model: e.model, product: e.product, transport: 'usb', error: e.error,
    })),
    scrcpy: { available: Boolean(scrcpy.available), version: scrcpy.version ?? null },
  }));
  route('GET', '/api/env', () => env);
  route('GET', '/api/log', () => logLines.slice(-200));

  route('GET', '/api/info', async (u) => {
    const serial = s(u);
    const [props, ...rest] = await Promise.all([out(serial, D.INFO_PROPS_CMD), ...D.INFO_CMDS.map((c) => out(serial, c))]);
    return D.parseInfo(props, rest);
  });
  route('GET', '/api/toggles', async (u) => D.parseToggles(await out(s(u), D.TOGGLES_READ_CMD)));
  route('POST', '/api/toggles', async (u, b) => {
    const t = D.TOGGLES[b.name];
    if (!t) throw new HttpError('Unknown toggle');
    const r = await sh(s(u, b), t.set(Boolean(b.on)));
    return { ok: r.ok, output: merged(r) };
  });
  route('POST', '/api/input', async (u, b) => {
    const serial = s(u, b);
    const cmd = D.inputCmd(b, b.type === 'tap' || b.type === 'swipe' ? await screenSize(serial) : null);
    if (cmd) await sh(serial, cmd);
    return { ok: true };
  });
  route('POST', '/api/open-url', async (u, b) => {
    if (!b.url || /[\r\n]/.test(b.url)) throw new HttpError('Invalid URL');
    if (b.pkg && !D.PKG_RE.test(b.pkg)) throw new HttpError('Invalid package name');
    const r = await sh(s(u, b), D.openUrlCmd(b.url, b.pkg));
    return { ok: r.ok && !/Error/.test(merged(r)), output: merged(r) };
  });
  route('POST', '/api/shell', async (u, b) => {
    if (!b.cmd?.trim()) throw new HttpError('Empty command');
    const r = await sh(s(u, b), b.cmd);
    return { ok: r.ok, code: r.code, output: merged(r) };
  });

  route('POST', '/api/record/start', (u, b) => startRecording(s(u, b), b));
  route('POST', '/api/record/stop', (u, b) => stopRecording(s(u, b)));
  route('GET', '/api/record', (u) => {
    const r = recordings.get(s(u));
    return r ? { recording: !r.done, startedAt: r.startedAt } : { recording: false };
  });
  route('POST', '/api/screenshot/copy', () => { throw new HttpError('The browser blocked copying the image — use the save button instead'); });

  const pkgOf = (pkg) => {
    if (!D.PKG_RE.test(pkg ?? '')) throw new HttpError('Invalid package name');
    return pkg;
  };
  route('GET', '/api/apps', async (u) => D.parsePackages(await out(s(u), D.listPackagesCmd(u.searchParams.get('all') === '1'))));
  route('GET', '/api/app', async (u) => {
    const pkg = pkgOf(u.searchParams.get('pkg'));
    const [dump, pid] = await Promise.all([out(s(u), D.appDumpCmd(pkg)), out(s(u), `pidof ${pkg}`)]);
    return D.parseAppDetails(pkg, dump, pid);
  });
  route('POST', '/api/app', async (u, b) => {
    const cmd = D.appActionCmd(pkgOf(b.pkg), b.action);
    if (!cmd) throw new HttpError('Unknown action');
    const r = await sh(s(u, b), cmd);
    return { ok: r.ok && D.appActionOk(merged(r)), output: merged(r) };
  });
  route('POST', '/api/logcat/clear', async (u, b) => ({ ok: (await sh(s(u, b), 'logcat -c')).ok }));

  route('POST', '/api/install', async (u, file) => {
    const serial = s(u);
    const adb = adbOf(serial);
    const remote = `/data/local/tmp/droidpanel-${Date.now()}.apk`;
    try {
      await adb.push(remote, file);
      const r = await sh(serial, `pm install -r -t ${remote}`);
      return { ok: /Success/.test(merged(r)), output: merged(r) };
    } finally {
      await sh(serial, `rm -f ${remote}`).catch(() => {});
    }
  });
  route('POST', '/api/push', async (u, file) => {
    const safe = String(u.searchParams.get('name') || 'file').split(/[\\/]/).pop().replace(/[^\w.\- ]/g, '_') || 'file';
    const remote = `/sdcard/Download/${safe}`;
    await adbOf(s(u)).push(remote, file);
    return { ok: true, output: `pushed to ${remote}`, remote };
  });

  // Desktop-only features: answer harmlessly so the UI stays quiet.
  route('GET', '/api/reverse', () => []);
  route('GET', '/api/projects', () => ({ projects: [], jobs: [] }));
  route('GET', '/api/projects/discover', () => []);
  route('GET', '/api/wireless/mdns', () => []);
  for (const p of ['/api/reverse', '/api/wireless/pair', '/api/wireless/connect', '/api/wireless/disconnect',
    '/api/wireless/usb-to-wifi', '/api/wireless/qr', '/api/projects', '/api/projects/run']) {
    route('POST', p, notHere(p.includes('wireless') ? 'Wi-Fi debugging' : p.includes('reverse') ? 'Port reverse' : 'Build & Run'));
  }

  // ── Public surface used by api.js ─────────────────────────────────────────

  async function api(path, { body, method } = {}) {
    const u = new URL(path, location.origin);
    const fn = routes.get(`${method ?? (body !== undefined ? 'POST' : 'GET')} ${u.pathname}`);
    if (!fn) throw new Error(`Not available in hosted mode: ${u.pathname}`);
    return (await fn(u, body)) ?? { ok: true };
  }

  async function fetchApi(path, { signal } = {}) {
    const u = new URL(path, location.origin);
    const fail = (e) => new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { 'content-type': 'application/json' } });
    try {
      const serial = u.searchParams.get('serial');
      if (u.pathname === '/api/screenshot') {
        return new Response(new Blob([await adbOf(serial).exec('screencap -p')], { type: 'image/png' }));
      }
      if (u.pathname === '/api/mirror') {
        const res = await startMirror(serial, Object.fromEntries(u.searchParams));
        signal?.addEventListener('abort', () => stopMirror(serial));
        return res;
      }
      if (u.pathname === '/api/app/apk') {
        const pkg = pkgOf(u.searchParams.get('pkg'));
        const remote = (await out(serial, `pm path ${pkg}`)).split('\n')[0]?.replace(/^package:/, '').trim();
        if (!remote) throw new HttpError('APK not found');
        return new Response(await adbOf(serial).pull(remote, 'application/vnd.android.package-archive'));
      }
      throw new HttpError(`Not available in hosted mode: ${u.pathname}`);
    } catch (e) {
      return fail(e);
    }
  }

  return {
    api,
    fetch: fetchApi,
    events,
    control,
    requestDevice,
    onChange: (fn) => listeners.add(fn),
  };
}
