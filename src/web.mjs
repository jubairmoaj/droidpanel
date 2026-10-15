// Hosted mode (`droidpanel --web`): a plain static server for a VPS.
//
// It has no adb and no access to any phone. The browser drives the phone directly over
// WebUSB (public/web/backend.js), so the only things served are the UI, /api/env and the
// scrcpy-server jar the browser pushes to the phone for mirroring.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { scrcpyInfo } from './mirror.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const HOME = process.env.DROIDPANEL_HOME ?? path.join(os.homedir(), '.config', 'droidpanel');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.dart': 'text/plain; charset=utf-8', '.kt': 'text/plain; charset=utf-8',
};

// Pinned scrcpy-server, downloaded on first start when scrcpy isn't installed on the host.
const SCRCPY = {
  version: '5.0',
  url: 'https://github.com/Genymobile/scrcpy/releases/download/v5.0/scrcpy-server-v5.0',
  sha256: '26cbc9ad0aced6c2282455bef4fb43462605c1f8758c74b4ab1dbf818c229daa',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'usb=(self), clipboard-read=(self), clipboard-write=(self)',
  'content-security-policy': [
    "default-src 'self'", "script-src 'self' https://cdn.jsdelivr.net", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "media-src 'self' blob:",
    // the PC helper (droidpanel agent) on this computer
    "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*", "frame-ancestors 'none'",
  ].join('; '),
};

/** Find a local scrcpy-server, or download the pinned one. Returns { available, server, version }. */
export async function resolveScrcpy(log = console.log) {
  const local = await scrcpyInfo();
  if (local.available) return local;
  const file = path.join(HOME, `scrcpy-server-v${SCRCPY.version}`);
  const sha = (buf) => createHash('sha256').update(buf).digest('hex');
  try {
    if (existsSync(file) && sha(await readFile(file)) === SCRCPY.sha256) return { available: true, server: file, version: SCRCPY.version };
    log(`Downloading scrcpy-server v${SCRCPY.version}…`);
    const res = await fetch(SCRCPY.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha(buf) !== SCRCPY.sha256) throw new Error('checksum mismatch');
    await mkdir(HOME, { recursive: true });
    await writeFile(`${file}.tmp`, buf);
    await rename(`${file}.tmp`, file);
    return { available: true, server: file, version: SCRCPY.version };
  } catch (e) {
    log(`scrcpy-server unavailable (${e.message}) — mirroring will use screenshot mode. Set SCRCPY_SERVER and SCRCPY_VERSION to fix.`);
    return { available: false };
  }
}

/** Short hash of everything in public/, so each deploy gets new asset URLs. */
function contentHash() {
  const h = createHash('sha256');
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else h.update(full.slice(PUBLIC.length)).update(readFileSync(full));
    }
  };
  walk(PUBLIC);
  return h.digest('hex').slice(0, 12);
}

export function createWebApp({ scrcpy }) {
  const env = JSON.stringify({ mode: 'web', scrcpy: { available: scrcpy.available, version: scrcpy.version ?? null } });
  // CDNs such as Cloudflare override no-cache on .js/.css with hours of browser caching, which
  // mixes old and new files after a deploy. So the page loads its assets from /v/<hash>/…
  // (via <base>), which can then be cached forever; only the HTML is revalidated.
  const version = contentHash();
  const indexHtml = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
    .replace('<head>', `<head>\n  <base href="/v/${version}/">`);

  function send(res, status, headers, body) {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }

  function sendFile(req, res, file, type, cache) {
    const st = statSync(file);
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': st.size, 'cache-control': cache });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  return createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    let immutable = false;
    const v = /^\/v\/[0-9a-f]+(\/.*)$/.exec(u.pathname);
    if (v) {
      u.pathname = v[1]; // any version is served from the current files; the HTML always names the current one
      immutable = true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { 'content-type': 'text/plain' }, 'Method not allowed');
    if (u.pathname === '/api/env') return send(res, 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }, env);
    if (u.pathname.startsWith('/api/')) return send(res, 404, { 'content-type': 'application/json' }, '{"error":"Not available in hosted mode"}');
    if (u.pathname === '/scrcpy-server') {
      if (!scrcpy.available) return send(res, 404, { 'content-type': 'text/plain' }, 'scrcpy-server not available');
      return sendFile(req, res, scrcpy.server, 'application/java-archive', 'public, max-age=86400');
    }
    let rel;
    try { rel = decodeURIComponent(u.pathname); } catch { return send(res, 400, { 'content-type': 'text/plain' }, 'Bad path'); }
    if (rel === '/' || rel === '/index.html') {
      return send(res, 200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' }, req.method === 'HEAD' ? '' : indexHtml);
    }
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { 'content-type': 'text/plain' }, 'Forbidden');
    let st;
    try { st = statSync(file); } catch { st = null; }
    if (!st?.isFile()) return send(res, 404, { 'content-type': 'text/plain' }, 'Not found');
    sendFile(req, res, file, TYPES[path.extname(file)] ?? 'application/octet-stream', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  });
}
