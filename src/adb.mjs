import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec, q, sleep, HttpError, HOST_RE, assertPkg, intIn } from './util.mjs';
import * as D from '../public/shared/device.js';

export const ADB = process.env.ADB || 'adb';

export const adbArgs = (serial, args) => (serial ? ['-s', serial, ...args] : args);
export const adb = (serial, args, opts) => exec(ADB, adbArgs(serial, args), opts);
export const adbSpawn = (serial, args, opts) => spawn(ADB, adbArgs(serial, args), opts);
/** Run one command line in the device shell. Quote untrusted parts with q(). */
export const shell = (serial, cmd, opts) => adb(serial, ['shell', cmd], opts);
const out = (r) => (r.stdout ?? '').trim();

// ── Devices ─────────────────────────────────────────────────────────────────

export async function listDevices() {
  const r = await exec(ADB, ['devices', '-l'], { timeout: 5000 });
  if (!r.ok && !r.stdout) return { adb: false, error: r.stderr || r.error, devices: [] };
  const devices = r.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*'))
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/);
      const kv = {};
      for (const t of rest) {
        const i = t.indexOf(':');
        if (i > 0) kv[t.slice(0, i)] = t.slice(i + 1);
      }
      const wifi = /:\d+$/.test(serial) || serial.includes('._adb-tls-connect.');
      return { serial, state, model: (kv.model ?? '').replace(/_/g, ' '), product: kv.product ?? '', transport: wifi ? 'wifi' : 'usb' };
    });
  return { adb: true, devices };
}

export async function deviceInfo(serial) {
  const [props, ...rest] = await Promise.all([shell(serial, D.INFO_PROPS_CMD), ...D.INFO_CMDS.map((c) => shell(serial, c))]);
  return D.parseInfo(out(props), rest.map(out));
}

let sizeCache = new Map(); // serial -> [w, h]
export async function screenSize(serial) {
  if (!sizeCache.has(serial)) {
    const size = D.parseScreenSize(out(await shell(serial, 'wm size')));
    if (!size) return null;
    sizeCache.set(serial, size);
  }
  return sizeCache.get(serial);
}

// ── Wireless debugging ──────────────────────────────────────────────────────

function host(h, defaultPort) {
  const s = String(h ?? '').trim();
  if (!s || !HOST_RE.test(s)) throw new HttpError(400, 'Invalid host');
  return defaultPort && !/:\d+$/.test(s) ? `${s}:${defaultPort}` : s;
}
const merged = (r) => [r.stdout, r.stderr, r.error].map((s) => (s ?? '').toString().trim()).filter(Boolean).join('\n');

export async function pair(addr, code) {
  if (!/^[\w-]{4,64}$/.test(String(code ?? ''))) throw new HttpError(400, 'Invalid pairing code');
  const r = await exec(ADB, ['pair', host(addr), String(code)], { timeout: 20000 });
  const text = merged(r);
  return { ok: /Successfully paired/i.test(text), output: text };
}

/** Quick TCP check so we can explain failures instead of waiting for adb's long timeout. */
function reachable(hostPort, ms = 2500) {
  const i = hostPort.lastIndexOf(':');
  return new Promise((resolve) => {
    const s = net.connect({ host: hostPort.slice(0, i).replace(/^\[|\]$/g, ''), port: Number(hostPort.slice(i + 1)) });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
const unreachableHelp = (target) => `This PC cannot reach the phone at ${target}.\n` +
  '• Make sure both are on the same Wi-Fi network (not mobile data / a guest network).\n' +
  '• Many routers block device-to-device traffic ("AP isolation" / "client isolation") — turn it off in the router, ' +
  'or use your phone\'s hotspot for the PC.\n• A VPN or firewall on either side can also block it.';

export async function connect(addr) {
  const target = host(addr, 5555);
  if (/^[\d.]+:\d+$/.test(target) && !(await reachable(target))) return { ok: false, output: unreachableHelp(target) };
  const r = await exec(ADB, ['connect', target], { timeout: 15000 });
  const text = merged(r);
  return { ok: /connected to/i.test(text) && !/failed|unable/i.test(text), output: text };
}

export async function disconnect(serial) {
  return { output: merged(await exec(ADB, serial ? ['disconnect', host(serial)] : ['disconnect'], { timeout: 5000 })) };
}

/** Switch a USB-connected device to TCP/IP mode and connect to it over Wi-Fi. */
export async function usbToWifi(serial) {
  const ip = out(await shell(serial, 'ip -f inet addr show wlan0')).match(/inet ([\d.]+)/)?.[1];
  if (!ip) throw new HttpError(400, 'Device has no Wi-Fi IP — is it on the same network?');
  await adb(serial, ['tcpip', '5555']);
  // adbd restarts in TCP mode; give it a few seconds to start listening.
  for (let i = 0; i < 6; i++) {
    await sleep(800);
    if (await reachable(`${ip}:5555`, 1200)) return connect(`${ip}:5555`);
  }
  return { ok: false, output: unreachableHelp(`${ip}:5555`) };
}

export async function mdnsServices() {
  const r = await exec(ADB, ['mdns', 'services'], { timeout: 5000 });
  return out(r)
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 3)
    .map(([name, type, addr]) => ({ name, type: type.replace(/\.$/, ''), addr }));
}

// QR pairing: the phone scans WIFI:T:ADB;S:<name>;P:<password>;; and then advertises an
// _adb-tls-pairing service with that name over mDNS, which we pair with.
let qrSession = null;
export function startQrPairing() {
  const name = `droidpanel-${randomBytes(3).toString('hex')}`;
  const password = randomBytes(4).toString('hex');
  const session = { name, password, status: 'waiting', message: 'Scan the QR code from Wireless debugging → Pair device with QR code', startedAt: Date.now() };
  qrSession = session;
  (async () => {
    while (qrSession === session && Date.now() - session.startedAt < 120000) {
      const svc = (await mdnsServices()).find((s) => s.name === name && s.type.includes('pairing'));
      if (svc) {
        session.status = 'pairing';
        session.message = `Found ${svc.addr}, pairing…`;
        const r = await pair(svc.addr, password);
        if (!r.ok) {
          Object.assign(session, { status: 'failed', message: r.output });
          return;
        }
        session.message = 'Paired. Connecting…';
        const ip = svc.addr.split(':')[0];
        for (let i = 0; i < 10; i++) {
          await sleep(1000);
          const conn = (await mdnsServices()).find((s) => s.type.includes('tls-connect') && s.addr.startsWith(ip + ':'));
          if (conn) {
            const c = await connect(conn.addr);
            Object.assign(session, { status: c.ok ? 'done' : 'failed', message: c.output });
            return;
          }
        }
        Object.assign(session, { status: 'done', message: 'Paired. If it does not appear, use Connect with the IP:port shown on the phone.' });
        return;
      }
      await sleep(1000);
    }
    if (qrSession === session && session.status === 'waiting') Object.assign(session, { status: 'failed', message: 'Timed out' });
  })();
  return { name, password, qr: `WIFI:T:ADB;S:${name};P:${password};;` };
}
export const qrStatus = () => qrSession && { status: qrSession.status, message: qrSession.message };

// ── Developer toggles ───────────────────────────────────────────────────────

export const { TOGGLES } = D;

export async function readToggles(serial) {
  return D.parseToggles(out(await shell(serial, D.TOGGLES_READ_CMD)));
}

export async function setToggle(serial, name, on) {
  const t = TOGGLES[name];
  if (!t) throw new HttpError(400, 'Unknown toggle');
  const r = await shell(serial, t.set(Boolean(on)));
  return { ok: r.ok, output: merged(r) };
}

// ── Screenshot & recording ──────────────────────────────────────────────────

export async function screenshot(serial) {
  const r = await adb(serial, ['exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 15000 });
  if (!r.ok || !r.stdout?.length) throw new HttpError(502, r.stderr || r.error || 'screencap failed');
  return r.stdout;
}

const recordings = new Map(); // serial -> { proc, remote, startedAt }
const recordedFiles = new Map(); // id -> local path
export function startRecording(serial, { bitrate = 8 } = {}) {
  if (recordings.has(serial)) throw new HttpError(409, 'Already recording');
  const remote = `/sdcard/droidpanel-${Date.now()}.mp4`;
  const proc = adbSpawn(serial, ['shell', 'screenrecord', '--bit-rate', String(intIn(bitrate, 1, 40, 8) * 1_000_000), remote]);
  const rec = { proc, remote, startedAt: Date.now(), closed: new Promise((r) => proc.on('close', r)) };
  recordings.set(serial, rec);
  // screenrecord stops on its own after 3 minutes
  rec.closed.then(() => { rec.done = true; });
  return { startedAt: rec.startedAt };
}
export const recordingState = (serial) => {
  const r = recordings.get(serial);
  return r ? { recording: !r.done, startedAt: r.startedAt } : { recording: false };
};
export async function stopRecording(serial) {
  const rec = recordings.get(serial);
  if (!rec) throw new HttpError(409, 'Not recording');
  if (!rec.done) await shell(serial, 'pkill -INT screenrecord');
  await Promise.race([rec.closed, sleep(5000)]);
  await sleep(700); // let the mp4 finish writing
  recordings.delete(serial);
  const id = randomBytes(6).toString('hex');
  const local = path.join(os.tmpdir(), `droidpanel-rec-${id}.mp4`);
  const r = await adb(serial, ['pull', rec.remote, local], { timeout: 60000 });
  await shell(serial, `rm -f ${q(rec.remote)}`);
  if (!r.ok) throw new HttpError(502, merged(r));
  recordedFiles.set(id, local);
  return { id, file: `/api/record/file?id=${id}` };
}
export const recordingFile = (id) => recordedFiles.get(id);

// ── Apps ────────────────────────────────────────────────────────────────────

export async function listPackages(serial, all) {
  return D.parsePackages(out(await shell(serial, D.listPackagesCmd(all))));
}

export async function appDetails(serial, pkg) {
  assertPkg(pkg);
  const [dump, pid] = await Promise.all([shell(serial, D.appDumpCmd(pkg)), shell(serial, `pidof ${pkg}`)]);
  return D.parseAppDetails(pkg, out(dump), out(pid));
}

export async function appAction(serial, pkg, action) {
  assertPkg(pkg);
  const cmd = action === 'uninstall' ? null : D.appActionCmd(pkg, action);
  const r = action === 'uninstall' ? await adb(serial, ['uninstall', pkg], { timeout: 60000 })
    : cmd ? await shell(serial, cmd)
      : null;
  if (!r) throw new HttpError(400, 'Unknown action');
  return { ok: r.ok && D.appActionOk(merged(r)), output: merged(r) };
}

export async function pullApk(serial, pkg) {
  assertPkg(pkg);
  const remote = out(await shell(serial, `pm path ${pkg}`)).split('\n')[0]?.replace(/^package:/, '').trim();
  if (!remote) throw new HttpError(404, 'APK not found');
  const local = path.join(os.tmpdir(), `droidpanel-${randomBytes(4).toString('hex')}-${pkg}.apk`);
  const r = await adb(serial, ['pull', remote, local], { timeout: 120000 });
  if (!r.ok) throw new HttpError(502, merged(r));
  return local;
}

export async function installApk(serial, file) {
  const r = await adb(serial, ['install', '-r', '-t', file], { timeout: 300000 });
  await rm(file, { force: true });
  const text = merged(r);
  return { ok: /Success/.test(text), output: text };
}

export async function pushFile(serial, file, name) {
  const safe = path.basename(String(name || 'file')).replace(/[^\w.\- ]/g, '_') || 'file';
  const remote = `/sdcard/Download/${safe}`;
  const r = await adb(serial, ['push', file, remote], { timeout: 300000 });
  await rm(file, { force: true });
  return { ok: r.ok, output: merged(r), remote };
}

// ── Misc ────────────────────────────────────────────────────────────────────

export async function openUrl(serial, url, pkg) {
  if (!url || /[\r\n]/.test(url)) throw new HttpError(400, 'Invalid URL');
  if (pkg) assertPkg(pkg);
  const r = await shell(serial, D.openUrlCmd(url, pkg));
  const text = merged(r);
  return { ok: r.ok && !/Error/.test(text), output: text };
}

export async function reverseList(serial) {
  const r = await adb(serial, ['reverse', '--list']);
  return out(r).split('\n').filter(Boolean).map((l) => {
    const p = l.trim().split(/\s+/);
    return { remote: p.at(-2), local: p.at(-1) };
  });
}

export async function reverseAdd(serial, remote, local) {
  const rp = intIn(remote, 1, 65535, 0), lp = intIn(local ?? remote, 1, 65535, 0);
  if (!rp || !lp) throw new HttpError(400, 'Invalid port');
  const r = await adb(serial, ['reverse', `tcp:${rp}`, `tcp:${lp}`]);
  return { ok: r.ok, output: merged(r) };
}

export async function reverseRemove(serial, remote) {
  if (!/^tcp:\d+$/.test(remote ?? '')) throw new HttpError(400, 'Invalid port');
  const r = await adb(serial, ['reverse', '--remove', remote]);
  return { ok: r.ok, output: merged(r) };
}

export async function runShell(serial, cmd) {
  if (!cmd?.trim()) throw new HttpError(400, 'Empty command');
  const r = await shell(serial, cmd, { timeout: 30000 });
  return { ok: r.ok, code: r.code, output: merged(r) };
}

export async function inputEvent(serial, p) {
  const cmd = D.inputCmd(p, p.type === 'tap' || p.type === 'swipe' ? await screenSize(serial) : null);
  if (cmd) return shell(serial, cmd);
}
