// ADB wire protocol (the part adbd speaks), independent of the transport.
// A transport has: write(header: Uint8Array, data: Uint8Array) and read() → { header, data }
// plus close(). See webusb.js.
//
// Protocol reference: https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/protocol.txt

const CMD = {
  CNXN: 0x4e584e43, AUTH: 0x48545541, OPEN: 0x4e45504f, OKAY: 0x59414b4f,
  CLSE: 0x45534c43, WRTE: 0x45545257, STLS: 0x534c5453,
};
const AUTH_TOKEN = 1, AUTH_SIGNATURE = 2, AUTH_RSAPUBLICKEY = 3;
const VERSION = 0x01000001;
const MAX_DATA = 1024 * 1024;
const FEATURES = ['shell_v2', 'cmd', 'stat_v2', 'ls_v2', 'fixed_push_mkdir', 'abb_exec'];

const enc = new TextEncoder();
const dec = new TextDecoder();

export function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function header(cmd, arg0, arg1, data) {
  const dv = new DataView(new ArrayBuffer(24));
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  dv.setUint32(0, cmd, true);
  dv.setUint32(4, arg0, true);
  dv.setUint32(8, arg1, true);
  dv.setUint32(12, data.length, true);
  dv.setUint32(16, sum >>> 0, true);
  dv.setUint32(20, (cmd ^ 0xffffffff) >>> 0, true);
  return new Uint8Array(dv.buffer);
}

export function parseHeader(h) {
  const dv = new DataView(h.buffer, h.byteOffset, 24);
  return { cmd: dv.getUint32(0, true), arg0: dv.getUint32(4, true), arg1: dv.getUint32(8, true), length: dv.getUint32(12, true) };
}

export class AdbError extends Error {}

/** One ADB stream (a service such as `shell:…` or `sync:`). */
export class AdbSocket {
  constructor(adb, localId, service) {
    this.adb = adb;
    this.localId = localId;
    this.service = service;
    this.remoteId = 0;
    this.closed = false;
    this.queue = [];
    this.waiters = [];
    this.writeAck = null;
    this.opened = new Promise((resolve, reject) => { this.openCbs = { resolve, reject }; });
  }

  // ── from the device ──
  onOkay(remoteId) {
    if (!this.remoteId) {
      this.remoteId = remoteId;
      this.openCbs.resolve(this);
    } else {
      const ack = this.writeAck;
      this.writeAck = null;
      ack?.resolve();
    }
  }

  onData(data) {
    const w = this.waiters.shift();
    if (w) w(data);
    else this.queue.push(data);
  }

  onClose() {
    if (!this.remoteId) this.openCbs.reject(new AdbError(`Service refused: ${this.service.split(':')[0]}`));
    this.dispose(true);
  }

  dispose(sendClose) {
    if (this.closed) return;
    this.closed = true;
    this.adb.sockets.delete(this.localId);
    if (sendClose && this.remoteId && !this.adb.closed) this.adb.send(CMD.CLSE, this.localId, this.remoteId).catch(() => {});
    for (const w of this.waiters.splice(0)) w(null);
    this.writeAck?.reject(new AdbError('Stream closed'));
    this.writeAck = null;
    this.onclose?.();
  }

  // ── for callers ──
  /** Next chunk of data, or null once the stream is closed and drained. */
  read() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((r) => this.waiters.push(r));
  }

  /** Send bytes. Concurrent calls are queued, since each WRTE must be acknowledged before the next. */
  write(data) {
    const run = () => this.writeNow(data);
    const p = (this.writeChain ?? Promise.resolve()).then(run, run);
    this.writeChain = p.catch(() => {});
    return p;
  }

  async writeNow(data) {
    for (let off = 0; off < data.length; off += this.adb.maxData) {
      if (this.closed) throw new AdbError('Stream closed');
      const chunk = data.subarray(off, off + this.adb.maxData);
      const ack = new Promise((resolve, reject) => { this.writeAck = { resolve, reject }; });
      ack.catch(() => {}); // may reject before we await it; the await below still throws
      await this.adb.send(CMD.WRTE, this.localId, this.remoteId, chunk);
      await ack; // adbd allows one unacknowledged WRTE per stream
    }
  }

  close() { this.dispose(true); }

  /** Read everything until the device closes the stream. */
  async readAll() {
    const parts = [];
    for (let c; (c = await this.read());) parts.push(c);
    return concat(parts);
  }

  get readable() {
    return new ReadableStream({
      pull: async (ctl) => {
        const c = await this.read();
        if (c) ctl.enqueue(c);
        else ctl.close();
      },
      cancel: () => this.close(),
    });
  }
}

/** Reads exact byte counts from a socket (for framed protocols: sync, shell v2). */
class Reader {
  constructor(socket) {
    this.socket = socket;
    this.buf = new Uint8Array(0);
  }

  async fill(n) {
    while (this.buf.length < n) {
      const c = await this.socket.read();
      if (!c) return false;
      this.buf = this.buf.length ? concat([this.buf, c]) : c;
    }
    return true;
  }

  async exact(n) {
    if (!(await this.fill(n))) throw new AdbError('Stream ended early');
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

/** A connected device. Create with Adb.connect(transport, key). */
export class Adb {
  constructor(transport) {
    this.transport = transport;
    this.sockets = new Map();
    this.nextId = 1;
    this.closed = false;
    this.maxData = MAX_DATA;
    this.sendChain = Promise.resolve();
    this.banner = { props: {}, features: new Set() };
    this.disconnected = new Promise((r) => { this.onDisconnect = r; });
  }

  /**
   * Handshake. Tries the key's signature first; if the phone doesn't know the key yet it
   * sends the public key, calls onPrompt(), and waits for the user to tap "Allow".
   */
  static async connect(transport, key, { onPrompt } = {}) {
    const adb = new Adb(transport);
    await adb.send(CMD.CNXN, VERSION, MAX_DATA, enc.encode(`host::features=${FEATURES.join(',')}`));
    let signed = false;
    for (;;) {
      const p = await adb.readPacket();
      if (p.cmd === CMD.CNXN) {
        adb.maxData = Math.min(MAX_DATA, p.arg1 || MAX_DATA);
        adb.parseBanner(dec.decode(p.data));
        break;
      }
      if (p.cmd === CMD.STLS) throw new AdbError('Device wants TLS (wireless debugging) — use USB');
      if (p.cmd !== CMD.AUTH || p.arg0 !== AUTH_TOKEN) continue;
      if (!signed) {
        signed = true;
        await adb.send(CMD.AUTH, AUTH_SIGNATURE, 0, key.sign(p.data));
      } else {
        await adb.send(CMD.AUTH, AUTH_RSAPUBLICKEY, 0, enc.encode(`${key.androidPublicKey()} droidpanel@browser\0`));
        onPrompt?.();
      }
    }
    adb.readLoop();
    return adb;
  }

  parseBanner(s) {
    // "device::ro.product.name=x;ro.product.model=y;ro.product.device=z;features=a,b"
    const [, , rest = ''] = s.split(':');
    for (const kv of rest.split(';')) {
      const i = kv.indexOf('=');
      if (i > 0) this.banner.props[kv.slice(0, i)] = kv.slice(i + 1);
    }
    this.banner.features = new Set((this.banner.props.features ?? '').split(',').filter(Boolean));
  }

  get model() { return (this.banner.props['ro.product.model'] ?? '').replace(/_/g, ' '); }
  get product() { return this.banner.props['ro.product.name'] ?? ''; }

  send(cmd, arg0, arg1, data = new Uint8Array(0)) {
    const run = () => {
      if (this.closed) throw new AdbError('Device disconnected');
      return this.transport.write(header(cmd, arg0, arg1, data), data);
    };
    const p = this.sendChain.then(run, run);
    this.sendChain = p.catch(() => {});
    return p;
  }

  async readPacket() {
    const { header: h, data } = await this.transport.read();
    return { ...parseHeader(h), data };
  }

  async readLoop() {
    try {
      while (!this.closed) {
        const p = await this.readPacket();
        const s = this.sockets.get(p.arg1);
        if (p.cmd === CMD.OKAY) s?.onOkay(p.arg0);
        else if (p.cmd === CMD.WRTE) {
          if (s) {
            s.onData(p.data);
            this.send(CMD.OKAY, p.arg1, p.arg0).catch(() => {});
          } else this.send(CMD.CLSE, 0, p.arg0).catch(() => {});
        } else if (p.cmd === CMD.CLSE) s?.onClose();
      }
    } catch (e) {
      this.dispose(e);
    }
  }

  dispose(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const s of [...this.sockets.values()]) s.dispose(false);
    this.transport.close().catch(() => {});
    this.onDisconnect(reason);
  }

  close() { this.dispose(new AdbError('closed')); }

  /** Open a service stream, e.g. `shell:ls` or `localabstract:name`. */
  async open(service) {
    const id = this.nextId++;
    const s = new AdbSocket(this, id, service);
    this.sockets.set(id, s);
    await this.send(CMD.OPEN, id, 0, enc.encode(`${service}\0`));
    return s.opened;
  }

  // ── Shell ──

  /**
   * Start a command. Callbacks get stdout/stderr bytes as they arrive.
   * Returns { socket, exit: Promise<exit code> }; close the socket to stop the command.
   */
  async spawn(cmd, { onStdout, onStderr } = {}) {
    if (!this.banner.features.has('shell_v2')) {
      const socket = await this.open(`shell:${cmd}`);
      const exit = (async () => {
        for (let c; (c = await socket.read());) onStdout?.(c);
        return 0;
      })();
      return { socket, exit };
    }
    const socket = await this.open(`shell,v2,raw:${cmd}`);
    const r = new Reader(socket);
    const exit = (async () => {
      let code = null;
      while (await r.fill(5)) {
        const id = r.buf[0];
        const len = new DataView(r.buf.buffer, r.buf.byteOffset + 1, 4).getUint32(0, true);
        await r.exact(5);
        const data = await r.exact(len);
        if (id === 1) onStdout?.(data);
        else if (id === 2) onStderr?.(data);
        else if (id === 3) {
          code = data[0];
          socket.close();
          break;
        }
      }
      return code ?? -1;
    })();
    return { socket, exit };
  }

  /** Run a command and collect its output. */
  async shell(cmd) {
    const out = [], err = [];
    const p = await this.spawn(cmd, { onStdout: (d) => out.push(d), onStderr: (d) => err.push(d) });
    const code = await p.exit;
    return { code, ok: code === 0, stdout: dec.decode(concat(out)), stderr: dec.decode(concat(err)) };
  }

  /** Binary-safe output of a command (no pty, no stderr), e.g. `screencap -p`. */
  async exec(cmd) {
    return (await this.open(`exec:${cmd}`)).readAll();
  }

  // ── Files (sync protocol) ──

  async sync(fn) {
    const socket = await this.open('sync:');
    try {
      return await fn(socket, new Reader(socket));
    } finally {
      socket.write(syncReq('QUIT', 0)).catch(() => {}).finally(() => socket.close());
    }
  }

  /** Upload a Blob or Uint8Array to `path`. */
  push(path, data, { mode = 0o644, onProgress } = {}) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    return this.sync(async (socket, r) => {
      const spec = enc.encode(`${path},${0o100000 | mode}`);
      await socket.write(concat([syncReq('SEND', spec.length), spec]));
      const CHUNK = 64 * 1024;
      let batch = [], batchLen = 0;
      const flush = async () => {
        if (!batchLen) return;
        await socket.write(concat(batch));
        batch = [];
        batchLen = 0;
      };
      for (let off = 0; off < blob.size; off += CHUNK) {
        const piece = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
        if (batchLen + piece.length + 8 > this.maxData) await flush();
        batch.push(syncReq('DATA', piece.length), piece);
        batchLen += piece.length + 8;
        onProgress?.(Math.min(blob.size, off + CHUNK), blob.size);
      }
      await flush();
      await socket.write(syncReq('DONE', Math.floor(Date.now() / 1000)));
      const res = await r.exact(8);
      const id = dec.decode(res.subarray(0, 4));
      if (id === 'FAIL') throw new AdbError(dec.decode(await r.exact(u32(res, 4))));
      if (id !== 'OKAY') throw new AdbError(`push: unexpected ${id}`);
    });
  }

  /** Download `path` as a Blob. */
  pull(path, type = 'application/octet-stream') {
    return this.sync(async (socket, r) => {
      const p = enc.encode(path);
      await socket.write(concat([syncReq('RECV', p.length), p]));
      const parts = [];
      for (;;) {
        const h = await r.exact(8);
        const id = dec.decode(h.subarray(0, 4));
        const len = u32(h, 4);
        if (id === 'DATA') parts.push(await r.exact(len));
        else if (id === 'DONE') break;
        else if (id === 'FAIL') throw new AdbError(dec.decode(await r.exact(len)));
        else throw new AdbError(`pull: unexpected ${id}`);
      }
      return new Blob(parts, { type });
    });
  }
}

const u32 = (b, off) => new DataView(b.buffer, b.byteOffset + off, 4).getUint32(0, true);

function syncReq(id, n) {
  const b = new Uint8Array(8);
  b.set(enc.encode(id));
  new DataView(b.buffer).setUint32(4, n, true);
  return b;
}
