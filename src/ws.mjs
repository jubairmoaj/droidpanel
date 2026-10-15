// Minimal WebSocket server side (RFC 6455) — enough for small control messages.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff])
      : (() => {
        const b = Buffer.alloc(10);
        b[0] = 0x80 | opcode;
        b[1] = 127;
        b.writeBigUInt64BE(BigInt(len), 2);
        return b;
      })();
  return Buffer.concat([head, payload]);
}

/**
 * Complete the handshake on an 'upgrade' socket.
 * Returns { send(text|Buffer), close(), onMessage(fn), onClose(fn) }.
 */
export function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  let onMessage = () => {};
  let onClose = () => {};
  let closed = false;
  let buf = Buffer.alloc(0);
  const close = () => {
    if (closed) return;
    closed = true;
    try { socket.end(frame(0x8, Buffer.alloc(0))); } catch { /* gone */ }
    onClose();
  };

  socket.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > 4 * 1024 * 1024) return socket.destroy();
      const maskAt = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i & 3)];
      buf = buf.subarray(off + len);
      if (op === 0x8) return close();
      if (op === 0x9) socket.write(frame(0xa, payload));
      else if (op === 0x1 || op === 0x2) onMessage(payload, op === 0x1);
    }
  });
  socket.on('close', () => { if (!closed) { closed = true; onClose(); } });
  socket.on('error', () => socket.destroy());

  return {
    send(data) {
      if (closed) return;
      const isText = typeof data === 'string';
      socket.write(frame(isText ? 0x1 : 0x2, isText ? Buffer.from(data) : data));
    },
    close,
    onMessage(fn) { onMessage = fn; },
    onClose(fn) { onClose = fn; },
  };
}
