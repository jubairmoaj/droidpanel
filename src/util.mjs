import { execFile } from 'node:child_process';
import { createWriteStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** Run a command and collect its output. Never rejects. */
export function exec(cmd, args, { timeout = 15000, encoding = 'utf8', cwd } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding, cwd, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout,
        stderr: stderr ? stderr.toString() : '',
        error: !err ? '' : err.killed ? `Timed out after ${Math.round(timeout / 1000)}s` : stderr ? '' : err.message,
      });
    });
  });
}

/** Call fn(line) for every complete line written to a readable stream. */
export function onLines(stream, fn) {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const parts = (rest + chunk).split(/\r?\n/);
    rest = parts.pop();
    for (const p of parts) fn(p);
  });
  stream.on('end', () => { if (rest) fn(rest); rest = ''; });
}

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/** Stream a request body to a temp file and return its path. */
export async function bodyToTempFile(req, ext = '') {
  const file = path.join(os.tmpdir(), `droidpanel-${randomBytes(6).toString('hex')}${ext}`);
  await pipeline(req, createWriteStream(file));
  return file;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export { q, PKG_RE, intIn } from '../public/shared/device.js';
import { PKG_RE } from '../public/shared/device.js';

export const HOST_RE = /^[\w.\-:[\]%]+$/;

export function assertPkg(pkg) {
  if (!PKG_RE.test(pkg ?? '')) throw new HttpError(400, 'Invalid package name');
  return pkg;
}

/** Minimal shell-like argument splitter supporting "double" and 'single' quotes. */
export function splitArgs(s) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s ?? ''))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]);
  return out;
}

export function which(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try {
        if (statSync(p).isFile()) return p;
      } catch { /* not here */ }
    }
  }
  return null;
}
