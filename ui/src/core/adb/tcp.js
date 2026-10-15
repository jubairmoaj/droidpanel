// ADB over TCP for adb.js, for phones in Wi-Fi debugging mode (`adb tcpip 5555`).
// A web page can't open TCP sockets, so the bytes go through the PC helper
// (src/agent.mjs, /tcp), which connects to the phone and pipes them both ways.
import { concat } from './adb.js';

export class TcpTransport {
  constructor(ws) {
    this.ws = ws;
    this.chunks = [];
    this.size = 0;
    this.waiter = null;
    this.closed = false;
    ws.onmessage = (e) => {
      const c = new Uint8Array(e.data);
      this.chunks.push(c);
      this.size += c.length;
      this.wake();
    };
    ws.onclose = () => {
      this.closed = true;
      this.wake();
    };
  }

  /** Open a TCP connection to host:port through the helper's WebSocket at `url`. */
  static open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      const fail = (e) => reject(new Error(e?.reason || 'Could not reach the phone over Wi-Fi'));
      ws.onerror = () => fail();
      ws.onclose = fail;
      // The helper sends one text message once the TCP connection is up (or an error).
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        const msg = JSON.parse(e.data);
        if (!msg.ok) return reject(new Error(msg.error));
        resolve(new TcpTransport(ws));
      };
    });
  }

  wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async take(n) {
    while (this.size < n) {
      if (this.closed) throw new Error('Wi-Fi connection closed');
      await new Promise((r) => { this.waiter = r; });
    }
    const all = this.chunks.length === 1 ? this.chunks[0] : concat(this.chunks);
    const out = all.slice(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
    return out;
  }

  async read() {
    const header = await this.take(24);
    const length = new DataView(header.buffer, header.byteOffset, 24).getUint32(12, true);
    return { header, data: length ? await this.take(length) : new Uint8Array(0) };
  }

  async write(header, data) {
    if (this.closed) throw new Error('Wi-Fi connection closed');
    this.ws.send(data.length ? concat([header, data]) : header);
  }

  async close() {
    this.closed = true;
    this.ws.close();
    this.wake();
  }
}
