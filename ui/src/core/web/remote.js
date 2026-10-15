// A Wi-Fi phone owned by the PC helper's private adb server (src/agent.mjs). It offers the same
// API as a USB Adb (shell, spawn, exec, push, pull, open), so the rest of the backend doesn't
// care how the phone is connected: each service stream is a WebSocket to the helper's /adb.
import { Adb, concat } from '../adb/adb.js';

/** Looks like AdbSocket to adb.js and backend.js: read() / write() / close() / readAll(). */
class WsStream {
  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') return;
      const c = new Uint8Array(e.data);
      const w = this.waiters.shift();
      if (w) w(c); else this.queue.push(c);
    };
    ws.onclose = () => this.dispose();
  }

  read() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((r) => this.waiters.push(r));
  }

  async write(data) {
    if (this.closed) throw new Error('Stream closed');
    this.ws.send(data);
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w(null);
    this.onclose?.();
  }

  close() {
    this.dispose();
    this.ws.close();
  }

  async readAll() {
    const parts = [];
    for (let c; (c = await this.read());) parts.push(c);
    return concat(parts);
  }

  get readable() {
    return new ReadableStream({
      pull: async (ctl) => {
        const c = await this.read();
        if (c) ctl.enqueue(c); else ctl.close();
      },
      cancel: () => this.close(),
    });
  }
}

export class RemoteAdb extends Adb {
  constructor({ serial, model, product, device, features }, urlFor) {
    super(null);
    this.serial = serial;
    this.urlFor = urlFor; // (serial, service) => ws URL
    this.maxData = 256 * 1024;
    this.banner.features = new Set(features ?? []);
    this.banner.props = { 'ro.product.model': model ?? '', 'ro.product.name': product ?? '', 'ro.product.device': device ?? '' };
  }

  open(service) {
    if (this.closed) return Promise.reject(new Error('Device disconnected'));
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.urlFor(this.serial, service));
      ws.binaryType = 'arraybuffer';
      ws.onerror = () => reject(new Error('PC helper connection failed'));
      ws.onclose = () => reject(new Error('closed'));
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        const msg = JSON.parse(e.data);
        if (!msg.ok) return reject(new Error(msg.error || 'closed'));
        resolve(new WsStream(ws));
      };
    });
  }

  dispose(reason) {
    if (this.closed) return;
    this.closed = true;
    this.onDisconnect(reason);
  }
}
