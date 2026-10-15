// A stand-in adb server for the PC helper (`droidpanel agent`).
//
// In hosted mode the browser owns the phone's USB connection (WebUSB). Flutter, Gradle
// and the job runner still call the normal `adb` binary, so the agent points them at this
// server (ANDROID_ADB_SERVER_PORT) and every device stream is tunnelled to the browser
// over a WebSocket, which opens it on the phone. The real adb server never runs, so the
// browser keeps the phone (mirror, logcat…) while builds install and hot reload.
//
// Speaks the adb client ⇄ server "smart socket" protocol:
// https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/SERVICES.TXT
import net from 'node:net';

const SERVER_VERSION = '0029'; // adb 1.0.41 — must match the client or it restarts the server
const HOST_FEATURES = 'shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,apex,abb,fixed_push_symlink_timestamp,abb_exec,'
  + 'remount_shell,track_app,sendrecv_v2,sendrecv_v2_brotli,sendrecv_v2_lz4,sendrecv_v2_zstd,sendrecv_v2_dry_run_send';
// Negotiated between server and adbd, which here is the browser; it doesn't implement them.
const TRANSPORT_ONLY_FEATURES = new Set(['delayed_ack']);

// Bridge frames (binary WebSocket messages): [type u8][stream id u32 BE][payload]
const F = { OPEN: 1, OK: 2, FAIL: 3, DATA: 4, CLOSE: 5 };

const hex4 = (n) => n.toString(16).padStart(4, '0');
const proto = (s) => {
  const b = Buffer.from(s);
  return Buffer.concat([Buffer.from(hex4(b.length)), b]);
};

function frame(type, id, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(5);
  h[0] = type;
  h.writeUInt32BE(id, 1);
  return Buffer.concat([h, payload]);
}

export function createRelay({ log = () => {} } = {}) {
  let bridge = null; // { ws, streams: Map<id, stream>, nextId }
  let devices = []; // [{ serial, state, model, product, device, features }]
  const trackers = new Set();
  const forwards = new Map(); // `tcp:<port>` -> { server, serial, local, remote }

  // ── Browser bridge ──

  function attachBridge(ws) {
    if (bridge) bridge.ws.close();
    const b = { ws, streams: new Map(), nextId: 1 };
    bridge = b;
    log('browser connected');
    ws.onMessage((data, isText) => {
      if (isText) {
        let msg;
        try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        if (msg.type === 'devices' && Array.isArray(msg.devices)) setDevices(msg.devices);
        return;
      }
      if (data.length < 5) return;
      const s = b.streams.get(data.readUInt32BE(1));
      if (!s) return;
      const payload = data.subarray(5);
      if (data[0] === F.OK) s.resolve(s);
      else if (data[0] === F.FAIL) s.end(payload.toString('utf8') || 'closed');
      else if (data[0] === F.DATA) s.deliver(Buffer.from(payload));
      else if (data[0] === F.CLOSE) s.end();
    });
    ws.onClose(() => {
      if (bridge !== b) return;
      bridge = null;
      for (const s of [...b.streams.values()]) s.end('browser disconnected');
      setDevices([]);
      log('browser disconnected');
    });
  }

  function setDevices(list) {
    devices = list.map((d) => ({
      serial: String(d.serial), state: String(d.state ?? 'offline'), model: String(d.model ?? ''),
      product: String(d.product ?? ''), device: String(d.device ?? ''),
      features: (d.features ?? []).filter((f) => !TRANSPORT_ONLY_FEATURES.has(f)),
    }));
    for (const t of trackers) t();
  }

  /** Open a service on the phone through the browser. Resolves with a stream, rejects with adb's error text. */
  function openStream(serial, service) {
    const b = bridge;
    if (!b) return Promise.reject(new Error('no devices/emulators found'));
    const id = b.nextId++;
    return new Promise((resolve, reject) => {
      // Data and close can arrive in the same packet as OK, before the caller attaches
      // onData/onEnd (it resumes on a later microtask), so both are held until then.
      const s = {
        id, onData: null, onEnd: null, ended: false, opened: false, held: [], endHeld: false,
        resolve: (x) => { s.opened = true; resolve(x); },
        deliver: (buf) => (s.onData ? s.onData(buf) : s.held.push(buf)),
        attach: (onData, onEnd) => {
          s.onData = onData;
          s.onEnd = onEnd;
          for (const b of s.held.splice(0)) onData(b);
          if (s.endHeld) onEnd();
        },
        write: (buf) => { if (!s.ended) b.ws.send(frame(F.DATA, id, buf)); },
        close: () => {
          if (s.ended) return;
          b.ws.send(frame(F.CLOSE, id));
          s.end();
        },
        end: (err) => {
          if (s.ended) return;
          s.ended = true;
          b.streams.delete(id);
          if (!s.opened) reject(new Error(err ?? 'closed'));
          else if (s.onEnd) s.onEnd();
          else s.endHeld = true;
        },
      };
      b.streams.set(id, s);
      b.ws.send(frame(F.OPEN, id, Buffer.from(JSON.stringify({ serial, service }))));
    });
  }

  // ── Device lookup ──

  const ready = () => devices.filter((d) => d.state === 'device');
  function pick(sel) {
    if (sel.serial !== undefined) {
      const d = devices.find((x) => x.serial === sel.serial);
      if (!d) throw new Error(`device '${sel.serial}' not found`);
      if (d.state !== 'device') throw new Error(`device ${d.state}`);
      return d;
    }
    if (sel.id !== undefined) {
      const d = ready()[sel.id - 1];
      if (!d) throw new Error(`no device with transport id '${sel.id}'`);
      return d;
    }
    const r = ready();
    if (!r.length) throw new Error('no devices/emulators found');
    if (r.length > 1) throw new Error('more than one device/emulator');
    return r[0];
  }
  const transportId = (d) => ready().indexOf(d) + 1;

  function deviceList(long) {
    return devices.map((d, i) => (long
      ? `${d.serial.padEnd(22)} ${d.state} usb:droidpanel product:${d.product} model:${d.model.replace(/\s/g, '_')} device:${d.device} transport_id:${i + 1}\n`
      : `${d.serial}\t${d.state}\n`)).join('');
  }

  // ── Port forwarding (flutter uses it for the Dart VM service) ──

  function addForward(d, spec) {
    const norebind = spec.startsWith('norebind:');
    const [local, remote] = spec.replace(/^norebind:/, '').split(';');
    const m = /^tcp:(\d+)$/.exec(local ?? '');
    if (!m || !remote) throw new Error(`cannot bind listener: unsupported spec '${spec}'`);
    const existing = forwards.get(local);
    if (existing && norebind) throw new Error('cannot rebind existing socket');
    existing?.server.close();
    return new Promise((resolve, reject) => {
      const server = net.createServer((c) => {
        c.pause();
        openStream(d.serial, remote).then((s) => pipe(c, s), () => c.destroy());
      });
      server.on('error', (e) => reject(new Error(`cannot bind listener: ${e.message}`)));
      server.listen(Number(m[1]), '127.0.0.1', () => {
        const port = server.address().port;
        forwards.delete(local);
        forwards.set(`tcp:${port}`, { server, serial: d.serial, local: `tcp:${port}`, remote });
        resolve(m[1] === '0' ? port : 0);
      });
    });
  }

  function removeForward(local) {
    const f = forwards.get(local);
    if (!f) throw new Error(`listener '${local}' not found`);
    f.server.close();
    forwards.delete(local);
  }

  // ── adb client connections ──

  function pipe(sock, s) {
    s.attach((b) => sock.write(b), () => sock.end());
    sock.on('data', (b) => s.write(b));
    sock.on('close', () => s.close());
    sock.on('error', () => s.close());
    sock.resume();
  }

  function handleClient(sock) {
    let buf = Buffer.alloc(0);
    let busy = false;
    let target = null; // device chosen by host:transport*
    const okay = (...extra) => sock.write(Buffer.concat([Buffer.from('OKAY'), ...extra]));
    const fail = (msg) => { sock.write(Buffer.concat([Buffer.from('FAIL'), proto(msg)])); sock.end(); };

    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      next();
    };
    sock.on('data', onData);
    sock.on('error', () => sock.destroy());

    async function next() {
      if (busy || buf.length < 4) return;
      const len = parseInt(buf.subarray(0, 4).toString('latin1'), 16);
      if (!Number.isFinite(len)) return sock.destroy();
      if (buf.length < 4 + len) return;
      const req = buf.subarray(4, 4 + len).toString('utf8');
      buf = buf.subarray(4 + len);
      busy = true;
      try {
        const keepGoing = await handle(req);
        busy = false;
        if (keepGoing) next();
      } catch (e) {
        fail(e.message);
      }
    }

    // Returns true when the connection stays in request mode (after a transport switch).
    async function handle(req) {
      if (!req.startsWith('host')) return service(req);

      let m;
      if (req === 'host:version') { okay(proto(SERVER_VERSION)); return sock.end(); }
      if (req === 'host:kill') { okay(); return sock.end(); }
      if (req === 'host:devices' || req === 'host:devices-l') { okay(proto(deviceList(req.endsWith('-l')))); return sock.end(); }
      if (req === 'host:track-devices' || req === 'host:track-devices-l') {
        const long = req.endsWith('-l');
        let last = null;
        const send = () => {
          const list = deviceList(long);
          if (list !== last) sock.write(proto((last = list)));
        };
        okay();
        send();
        trackers.add(send);
        sock.on('close', () => trackers.delete(send));
        return false;
      }
      if (req === 'host:host-features') { okay(proto(HOST_FEATURES)); return sock.end(); }

      // host:transport…, host:tport:… select the device for the next request on this connection
      // (transport:<serial>, transport-any/-usb/-local, transport-id:<n>, tport:serial:<s>, tport:any, tport:id:<n>)
      if ((m = /^host:(transport|tport)[-:](.*)$/.exec(req))) {
        const arg = m[2];
        const sel = arg === 'any' || arg === 'usb' || arg === 'local' ? {}
          : arg.startsWith('id:') ? { id: Number(arg.slice(3)) }
            : arg.startsWith('serial:') ? { serial: arg.slice(7) }
              : { serial: arg };
        target = pick(sel);
        if (m[1] === 'tport') {
          const id = Buffer.alloc(8);
          id.writeBigUInt64LE(BigInt(transportId(target)));
          okay(id);
        } else okay();
        return true;
      }

      // host-serial:<serial>:<cmd>, host-transport-id:<id>:<cmd>, host-usb:<cmd>, host:<cmd>
      const CMD = '(get-state|get-serialno|get-devpath|features|list-forward|killforward-all|forward:.*|killforward:.*|wait-for-.*|reconnect.*)';
      let sel = {}, cmd;
      if ((m = new RegExp(`^host-serial:(.+?):${CMD}$`).exec(req))) [sel, cmd] = [{ serial: m[1] }, m[2]];
      else if ((m = new RegExp(`^host-transport-id:(\\d+):${CMD}$`).exec(req))) [sel, cmd] = [{ id: Number(m[1]) }, m[2]];
      else if ((m = new RegExp(`^host(?:-usb|-local)?:${CMD}$`).exec(req))) cmd = m[1];
      else return fail(`unsupported in droidpanel: ${req}`);

      if (cmd.startsWith('wait-for-')) {
        okay();
        const check = () => {
          try { pick(sel); } catch { return false; }
          trackers.delete(check);
          okay();
          sock.end();
          return true;
        };
        if (!check()) {
          trackers.add(check);
          sock.on('close', () => trackers.delete(check));
        }
        return false;
      }
      if (cmd === 'list-forward') {
        okay(proto([...forwards.values()].map((f) => `${f.serial} ${f.local} ${f.remote}\n`).join('')));
        return sock.end();
      }
      if (cmd === 'killforward-all') {
        for (const k of [...forwards.keys()]) removeForward(k);
        okay(Buffer.from('OKAY'));
        return sock.end();
      }
      if (cmd.startsWith('killforward:')) {
        removeForward(cmd.slice(12));
        okay(Buffer.from('OKAY'));
        return sock.end();
      }
      const d = pick(sel);
      if (cmd.startsWith('forward:')) {
        const port = await addForward(d, cmd.slice(8));
        okay(Buffer.from('OKAY'), port ? proto(String(port)) : Buffer.alloc(0));
        return sock.end();
      }
      if (cmd === 'get-state') okay(proto('device'));
      else if (cmd === 'get-serialno') okay(proto(d.serial));
      else if (cmd === 'get-devpath') okay(proto('usb:droidpanel'));
      else if (cmd === 'features') okay(proto(d.features.join(',')));
      else return fail(`unsupported in droidpanel: ${req}`);
      return sock.end();
    }

    // Any other request is a device service (shell:, exec:, sync:, abb_exec:, reverse:…).
    async function service(req) {
      const d = target ?? pick({});
      if (/^reverse:forward:/.test(req)) return fail('adb reverse is not supported in hosted mode');
      let s;
      try {
        s = await openStream(d.serial, req);
      } catch (e) {
        return fail(e.message);
      }
      sock.off('data', onData);
      okay();
      if (buf.length) s.write(buf);
      buf = Buffer.alloc(0);
      pipe(sock, s);
      return false;
    }
  }

  const server = net.createServer(handleClient);
  return {
    server,
    attachBridge,
    get connected() { return Boolean(bridge); },
    get devices() { return devices; },
  };
}
