// Screen mirror client.
//  • "live" mode: scrcpy H.264 stream → WebCodecs → <canvas>; input goes over a WebSocket
//    as scrcpy control messages (real-time touch, keys, text, clipboard).
//  • "lite" mode (no scrcpy or no WebCodecs): screenshots polled ~2×/s; input via adb.
import { api } from './api.js';

// scrcpy control message types
const MSG = { KEY: 0, TEXT: 1, TOUCH: 2, SCROLL: 3, BACK_OR_SCREEN_ON: 4, EXPAND_NOTIF: 5, COLLAPSE: 7, SET_CLIPBOARD: 9, ROTATE: 11 };
const ACTION = { DOWN: 0, UP: 1, MOVE: 2 };
const FINGER = -2n; // POINTER_ID_GENERIC_FINGER

// Browser KeyboardEvent.key → Android keycode (non-printable keys)
const KEYMAP = {
  Enter: 66, Backspace: 67, Delete: 112, Tab: 61, Escape: 111, ArrowUp: 19, ArrowDown: 20,
  ArrowLeft: 21, ArrowRight: 22, Home: 122, End: 123, PageUp: 92, PageDown: 93,
};

function codecString(cfg) { // avc1.PPCCLL from the SPS NAL unit
  const hex = (b) => b.toString(16).padStart(2, '0');
  for (let i = 0; i + 6 < cfg.length; i++) {
    if (cfg[i] === 0 && cfg[i + 1] === 0 && cfg[i + 2] === 1 && (cfg[i + 3] & 0x1f) === 7) {
      return `avc1.${hex(cfg[i + 4])}${hex(cfg[i + 5])}${hex(cfg[i + 6])}`;
    }
  }
  return 'avc1.42001f';
}

const i16fp = (f) => Math.max(-0x8000, Math.min(0x7fff, Math.round(Math.max(-1, Math.min(1, f)) * 0x8000)));

export class Mirror {
  constructor({ canvas, stage, onState, onStats, toast }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.stage = stage;
    this.onState = onState;
    this.onStats = onStats;
    this.toast = toast;
    this.mode = null; // 'live' | 'lite' | null
    this.serial = null;
    this.abort = null;
    this.ws = null;
    this.frames = 0;
    this.bytes = 0;
    this.bindInput();
  }

  get active() { return this.mode !== null; }

  async start(serial, quality, scrcpyAvailable) {
    this.stop();
    this.serial = serial;
    const useLive = scrcpyAvailable && 'VideoDecoder' in window;
    this.mode = useLive ? 'live' : 'lite';
    this.abort = new AbortController();
    this.onState('connecting');
    this.statsTimer = setInterval(() => this.reportStats(), 1000);
    if (!useLive) {
      this.toast(scrcpyAvailable ? 'Browser lacks WebCodecs — using lite mode' : 'scrcpy not found — using lite (screenshot) mode');
      return this.runLite(this.abort.signal);
    }
    const [maxSize, fps, bitrate] = quality.split(',');
    const signal = this.abort.signal;
    try {
      const qs = new URLSearchParams({ serial, maxSize, fps, bitrate });
      const res = await fetch(`/api/mirror?${qs}`, { signal });
      if (!res.ok) throw new Error(await res.text());
      this.openControl(serial);
      await this.consume(res.body.getReader(), signal);
      if (!signal.aborted) { this.stop(); this.onState('ended'); }
    } catch (e) {
      if (!signal.aborted) { this.stop(); this.onState('error', e.message); }
    }
  }

  stop() {
    this.abort?.abort();
    this.abort = null;
    this.ws?.close();
    this.ws = null;
    this.decoder?.state !== 'closed' && this.decoder?.close();
    this.decoder = null;
    clearInterval(this.statsTimer);
    this.mode = null;
    this.stage.classList.remove('live');
    this.onState('off');
  }

  reportStats() {
    const kbps = Math.round((this.bytes * 8) / 1000);
    this.onStats(this.mode === 'live'
      ? `${this.canvas.width}×${this.canvas.height} · ${this.frames} fps · ${kbps} kbps`
      : `${this.canvas.width}×${this.canvas.height} · lite mode · ${this.frames} fps`);
    this.frames = 0;
    this.bytes = 0;
  }

  showFrame() {
    if (!this.stage.classList.contains('live')) {
      this.stage.classList.add('live');
      this.onState('live');
    }
  }

  // ── Live mode ─────────────────────────────────────────────────────────────

  openControl(serial) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/mirror/control?serial=${encodeURIComponent(serial)}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const msg = JSON.parse(e.data);
      if (msg.type === 'clipboard') {
        navigator.clipboard?.writeText(msg.text).then(
          () => this.toast('Device clipboard copied to PC'),
          () => {},
        );
      }
    };
    this.ws = ws;
  }

  send(buf) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(buf);
      return true;
    }
    return false;
  }

  async consume(reader, signal) {
    let buf = new Uint8Array(0);
    const need = async (n) => {
      while (buf.length < n) {
        const { value, done } = await reader.read();
        if (done || signal.aborted) return false;
        this.bytes += value.length;
        const b = new Uint8Array(buf.length + value.length);
        b.set(buf);
        b.set(value, buf.length);
        buf = b;
      }
      return true;
    };
    const take = (n) => { const o = buf.subarray(0, n); buf = buf.subarray(n); return o; };

    if (!(await need(8))) return;
    take(4); // codec id
    // scrcpy ≥3 sends "session" packets (bit 63 set) instead of a fixed width/height header.
    const head = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
    const sessionFormat = (head & 0x80000000) !== 0;
    if (!sessionFormat) { await need(8); take(8); } // legacy: width, height
    const CONFIG = sessionFormat ? 0x40000000 : 0x80000000;
    const KEY = sessionFormat ? 0x20000000 : 0x40000000;
    const PTS_MASK = sessionFormat ? 0x1fffffffffffffffn : 0x3fffffffffffffffn;

    let config = null;
    let waitingKey = true;
    const configure = () => {
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
      this.decoder = new VideoDecoder({
        output: (frame) => {
          if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
          }
          this.ctx.drawImage(frame, 0, 0);
          frame.close();
          this.frames++;
          this.showFrame();
        },
        error: (e) => { console.warn('decoder error', e); waitingKey = true; },
      });
      this.decoder.configure({ codec: codecString(config), optimizeForLatency: true });
      waitingKey = true;
    };

    for (;;) {
      if (!(await need(12))) return;
      const h = take(12).slice();
      const dv = new DataView(h.buffer);
      const hi = dv.getUint32(0);
      if (sessionFormat && hi & 0x80000000) continue; // session packet: new size, no payload
      const len = dv.getUint32(8);
      if (!(await need(len))) return;
      const data = take(len);
      if (hi & CONFIG) { config = data.slice(); configure(); continue; }
      if (!config) continue;
      if (this.decoder.state === 'closed') configure();
      const isKey = (hi & KEY) !== 0;
      if (waitingKey && !isKey) continue;
      let payload = data;
      if (isKey) { // the decoder wants SPS/PPS in front of each keyframe
        payload = new Uint8Array(config.length + data.length);
        payload.set(config);
        payload.set(data, config.length);
        waitingKey = false;
      }
      const pts = Number(dv.getBigUint64(0) & PTS_MASK);
      this.decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: pts, data: payload }));
    }
  }

  // ── Lite mode ─────────────────────────────────────────────────────────────

  async runLite(signal) {
    while (!signal.aborted) {
      const t = performance.now();
      try {
        const res = await fetch(`/api/screenshot?serial=${encodeURIComponent(this.serial)}`, { signal });
        if (!res.ok) throw new Error((await res.json()).error);
        const bmp = await createImageBitmap(await res.blob(), { resizeWidth: 720, resizeQuality: 'medium' });
        if (this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) {
          this.canvas.width = bmp.width;
          this.canvas.height = bmp.height;
        }
        this.ctx.drawImage(bmp, 0, 0);
        bmp.close();
        this.frames++;
        this.showFrame();
      } catch (e) {
        if (signal.aborted) return;
        this.stop();
        this.onState('error', e.message);
        return;
      }
      await new Promise((r) => setTimeout(r, Math.max(0, 400 - (performance.now() - t))));
    }
  }

  // ── Control messages ──────────────────────────────────────────────────────

  touch(action, nx, ny) {
    const w = this.canvas.width, h = this.canvas.height;
    const b = new DataView(new ArrayBuffer(32));
    b.setUint8(0, MSG.TOUCH);
    b.setUint8(1, action);
    b.setBigInt64(2, FINGER);
    b.setInt32(10, Math.round(nx * w));
    b.setInt32(14, Math.round(ny * h));
    b.setUint16(18, w);
    b.setUint16(20, h);
    b.setUint16(22, action === ACTION.UP ? 0 : 0xffff);
    b.setInt32(24, 0); // action button
    b.setInt32(28, 0); // buttons
    return this.send(b.buffer);
  }

  scroll(nx, ny, dy) {
    const w = this.canvas.width, h = this.canvas.height;
    const b = new DataView(new ArrayBuffer(21));
    b.setUint8(0, MSG.SCROLL);
    b.setInt32(1, Math.round(nx * w));
    b.setInt32(5, Math.round(ny * h));
    b.setUint16(9, w);
    b.setUint16(11, h);
    b.setInt16(13, 0);
    b.setInt16(15, i16fp(dy / 16));
    b.setInt32(17, 0);
    return this.send(b.buffer);
  }

  keyMsg(action, code, meta = 0) {
    const b = new DataView(new ArrayBuffer(14));
    b.setUint8(0, MSG.KEY);
    b.setUint8(1, action);
    b.setInt32(2, code);
    b.setInt32(6, 0);
    b.setInt32(10, meta);
    return this.send(b.buffer);
  }

  /** Press a key; falls back to adb when not live. */
  key(code) {
    if (this.mode === 'live' && this.keyMsg(ACTION.DOWN, code) && this.keyMsg(ACTION.UP, code)) return;
    if (this.serial) api('/api/input', { body: { serial: this.serial, type: 'key', code } });
  }

  text(str) {
    if (this.mode === 'live') {
      const bytes = new TextEncoder().encode(str).slice(0, 300);
      const b = new Uint8Array(5 + bytes.length);
      new DataView(b.buffer).setUint8(0, MSG.TEXT);
      new DataView(b.buffer).setUint32(1, bytes.length);
      b.set(bytes, 5);
      if (this.send(b.buffer)) return;
    }
    api('/api/input', { body: { serial: this.serial, type: 'text', text: str } });
  }

  pasteToDevice(str) {
    const bytes = new TextEncoder().encode(str);
    const b = new Uint8Array(14 + bytes.length);
    const dv = new DataView(b.buffer);
    dv.setUint8(0, MSG.SET_CLIPBOARD);
    dv.setBigUint64(1, BigInt(Date.now()));
    dv.setUint8(9, 1); // paste after setting
    dv.setUint32(10, bytes.length);
    b.set(bytes, 14);
    return this.send(b.buffer);
  }

  simple(type, extra = []) {
    return this.send(new Uint8Array([type, ...extra]).buffer);
  }

  backOrScreenOn() {
    if (this.mode === 'live' && this.simple(MSG.BACK_OR_SCREEN_ON, [ACTION.DOWN]) && this.simple(MSG.BACK_OR_SCREEN_ON, [ACTION.UP])) return;
    this.key(4);
  }

  notifications() {
    if (this.mode === 'live' && this.simple(MSG.EXPAND_NOTIF)) return;
    if (this.serial) api('/api/shell', { body: { serial: this.serial, cmd: 'cmd statusbar expand-notifications' } });
  }

  rotate() {
    if (this.mode === 'live' && this.simple(MSG.ROTATE)) return;
    this.toast('Rotate needs live mirror mode');
  }

  // ── Input binding ─────────────────────────────────────────────────────────

  bindInput() {
    const c = this.canvas;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
    };
    let down = null;
    let pendingMove = null;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      c.focus();
      if (e.button === 2) return this.backOrScreenOn();
      if (e.button === 1) { e.preventDefault(); return this.key(3); }
      const p = pos(e);
      down = { ...p, t: performance.now() };
      c.setPointerCapture(e.pointerId);
      if (this.mode === 'live') this.touch(ACTION.DOWN, p.x, p.y);
    });
    c.addEventListener('pointermove', (e) => {
      if (!down || this.mode !== 'live') return;
      const first = !pendingMove;
      pendingMove = pos(e);
      if (first) requestAnimationFrame(() => {
        if (pendingMove && down) this.touch(ACTION.MOVE, pendingMove.x, pendingMove.y);
        pendingMove = null;
      });
    });
    const up = (e) => {
      if (!down) return;
      const p = pos(e);
      if (this.mode === 'live') {
        this.touch(ACTION.UP, p.x, p.y);
      } else {
        const ms = Math.round(performance.now() - down.t);
        const moved = Math.hypot((p.x - down.x) * c.clientWidth, (p.y - down.y) * c.clientHeight) > 8;
        const land = c.width > c.height;
        api('/api/input', {
          body: moved || ms > 500
            ? { serial: this.serial, type: 'swipe', x: down.x, y: down.y, x2: p.x, y2: p.y, ms: Math.max(ms, 80), land }
            : { serial: this.serial, type: 'tap', x: p.x, y: p.y, land },
        });
      }
      down = null;
      pendingMove = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);

    let lastLiteWheel = 0;
    c.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      const p = pos(e);
      const notches = -e.deltaY / (e.deltaMode === 1 ? 3 : 100);
      if (this.mode === 'live') return this.scroll(p.x, p.y, notches);
      if (performance.now() - lastLiteWheel < 300) return;
      lastLiteWheel = performance.now();
      const land = c.width > c.height;
      const y2 = Math.min(1, Math.max(0, p.y + (notches > 0 ? 0.25 : -0.25)));
      api('/api/input', { body: { serial: this.serial, type: 'swipe', x: p.x, y: p.y, x2: p.x, y2, ms: 150, land } });
    }, { passive: false });

    c.addEventListener('keydown', async (e) => {
      if (!this.active) return;
      const mod = e.ctrlKey || e.metaKey;
      if ((mod && e.shiftKey) || e.altKey) return; // leave app shortcuts alone
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        try {
          const text = await navigator.clipboard.readText();
          if (!(this.mode === 'live' && this.pasteToDevice(text))) this.text(text);
        } catch { this.toast('Clipboard read was blocked by the browser'); }
        return;
      }
      if (mod) return;
      if (KEYMAP[e.key]) {
        e.preventDefault();
        this.key(KEYMAP[e.key]);
      } else if (e.key.length === 1) {
        e.preventDefault();
        this.text(e.key);
      }
    });
  }
}
