// Device-side commands and output parsers shared by the local Node server (src/adb.mjs)
// and the hosted WebUSB mode (public/web/backend.js). Plain ESM, no Node or DOM APIs.

/** Single-quote a value for the Android (mksh) shell. */
export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const PKG_RE = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/;

export function intIn(v, lo, hi, dflt) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

// ── Device info ─────────────────────────────────────────────────────────────

export const INFO_PROPS_CMD = [
  'getprop ro.product.manufacturer', 'getprop ro.product.model', 'getprop ro.build.version.release',
  'getprop ro.build.version.sdk', 'getprop ro.product.cpu.abi', 'getprop ro.build.display.id',
].join(';');
export const INFO_CMDS = ['wm size', 'wm density', 'dumpsys battery', 'ip -f inet addr show wlan0', 'df -h /data', 'cat /proc/uptime'];

/** Build the /api/info result from the output of INFO_PROPS_CMD and each of INFO_CMDS. */
export function parseInfo(propsOut, [size, density, bat, ip, df, uptime]) {
  const [manufacturer, model, android, sdk, abi, build] = propsOut.trim().split('\n').map((s) => s.trim());
  const last = (s) => [...s.trim().matchAll(/(\d+x\d+|\d+)\s*$/gm)].at(-1)?.[1] ?? '';
  const dfLine = df.trim().split('\n').at(-1).trim().split(/\s+/);
  const temp = Number(bat.match(/temperature: (\d+)/)?.[1]);
  return {
    manufacturer, model, android, sdk, abi, build,
    screen: last(size), density: last(density),
    battery: {
      level: Number(bat.match(/level: (\d+)/)?.[1] ?? NaN),
      charging: /(AC|USB|Wireless) powered: true/.test(bat),
      temp: Number.isFinite(temp) ? temp / 10 : null,
    },
    ip: ip.match(/inet ([\d.]+)/)?.[1] ?? null,
    storage: dfLine.length >= 5 ? { size: dfLine[1], used: dfLine[2], free: dfLine[3], pct: dfLine[4] } : null,
    uptimeSec: Math.round(Number(uptime.trim().split(' ')[0]) || 0),
  };
}

/** Last WxH in `wm size` output (an override, if any, is listed last). */
export function parseScreenSize(out) {
  const m = [...out.matchAll(/(\d+)x(\d+)/g)].at(-1);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// ── Developer toggles ───────────────────────────────────────────────────────

const REFRESH_PROPS = 'service call activity 1599295570 >/dev/null 2>&1';
export const TOGGLES = {
  show_taps: {
    label: 'Show taps',
    read: 'settings get system show_touches', on: (v) => v === '1',
    set: (on) => `settings put system show_touches ${on ? 1 : 0}`,
  },
  pointer_location: {
    label: 'Pointer location',
    read: 'settings get system pointer_location', on: (v) => v === '1',
    set: (on) => `settings put system pointer_location ${on ? 1 : 0}`,
  },
  layout_bounds: {
    label: 'Layout bounds',
    read: 'getprop debug.layout', on: (v) => v === 'true',
    set: (on) => `setprop debug.layout ${on}; ${REFRESH_PROPS}`,
  },
  gpu_overdraw: {
    label: 'GPU overdraw',
    read: 'getprop debug.hwui.overdraw', on: (v) => v === 'show',
    set: (on) => `setprop debug.hwui.overdraw ${on ? 'show' : 'false'}; ${REFRESH_PROPS}`,
  },
  no_animations: {
    label: 'Animations off',
    read: 'settings get global animator_duration_scale', on: (v) => v === '0' || v === '0.0',
    set: (on) => ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']
      .map((k) => `settings put global ${k} ${on ? 0 : 1}`).join(';'),
  },
  dark_mode: {
    label: 'Dark mode',
    read: 'cmd uimode night', on: (v) => /yes/i.test(v),
    set: (on) => `cmd uimode night ${on ? 'yes' : 'no'}`,
  },
  large_font: {
    label: 'Large font (1.3×)',
    read: 'settings get system font_scale', on: (v) => Number(v) > 1.05,
    set: (on) => `settings put system font_scale ${on ? '1.3' : '1.0'}`,
  },
  dont_keep_activities: {
    label: "Don't keep activities",
    read: 'settings get global always_finish_activities', on: (v) => v === '1',
    set: (on) => `settings put global always_finish_activities ${on ? 1 : 0}`,
  },
  stay_awake: {
    label: 'Stay awake while charging',
    read: 'settings get global stay_on_while_plugged_in', on: (v) => Number(v) > 0,
    set: (on) => `settings put global stay_on_while_plugged_in ${on ? 7 : 0}`,
  },
};

export const TOGGLES_READ_CMD = Object.values(TOGGLES).map((t) => `echo "@@$(${t.read} 2>/dev/null)"`).join(';');

export function parseToggles(out) {
  const vals = out.trim().split('\n').filter((l) => l.startsWith('@@')).map((l) => l.slice(2).trim());
  return Object.entries(TOGGLES).map(([name, t], i) => ({ name, label: t.label, on: vals[i] !== undefined && t.on(vals[i]) }));
}

// ── Apps ────────────────────────────────────────────────────────────────────

export const listPackagesCmd = (all) => `pm list packages ${all ? '' : '-3'}`;
export const parsePackages = (out) => out.trim().split('\n').map((l) => l.replace(/^package:/, '').trim()).filter(Boolean).sort();

export const appDumpCmd = (pkg) => `dumpsys package ${pkg} | grep -E 'versionName|versionCode|firstInstallTime|lastUpdateTime|targetSdk' | head -8`;
export function parseAppDetails(pkg, dump, pidOut) {
  const d = dump.trim();
  return {
    pkg,
    versionName: d.match(/versionName=(\S+)/)?.[1] ?? null,
    versionCode: d.match(/versionCode=(\d+)/)?.[1] ?? null,
    targetSdk: d.match(/targetSdk=(\d+)/)?.[1] ?? null,
    firstInstall: d.match(/firstInstallTime=(.+)/)?.[1]?.trim() ?? null,
    lastUpdate: d.match(/lastUpdateTime=(.+)/)?.[1]?.trim() ?? null,
    pids: pidOut.trim().split(/\s+/).filter(Boolean),
  };
}

/** Shell command for an app action, or null if unknown. `uninstall` is handled by the caller. */
export function appActionCmd(pkg, action) {
  const launch = `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`;
  return {
    launch,
    stop: `am force-stop ${pkg}`,
    restart: `am force-stop ${pkg}; ${launch}`,
    clear: `pm clear ${pkg}`,
    info: `am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:${pkg}`,
    uninstall: `pm uninstall ${pkg}`,
  }[action] ?? null;
}
export const appActionOk = (output) => !/Failure|Error:|No activities found/i.test(output);

export const openUrlCmd = (url, pkg) => `am start -W -a android.intent.action.VIEW -d ${q(url)}${pkg ? ` ${pkg}` : ''}`;

// ── Input (adb fallback when the mirror is not live) ────────────────────────

/** Shell command for a tap/swipe/key/text event. `size` is the screen size in pixels (natural orientation). */
export function inputCmd(p, size) {
  const num = (v, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
  };
  if (p.type === 'key') return `input keyevent ${intIn(p.code, 0, 999, 0)}`;
  if (p.type === 'text') return `input text ${q(String(p.text ?? '').replace(/ /g, '%s'))}`;
  if (!size) return null;
  const [s, l] = [Math.min(...size), Math.max(...size)];
  const [w, h] = p.land ? [l, s] : [s, l];
  const px = (v, d) => Math.round(num(v, 0, 1) * d);
  if (p.type === 'tap') return `input tap ${px(p.x, w)} ${px(p.y, h)}`;
  if (p.type === 'swipe') return `input swipe ${px(p.x, w)} ${px(p.y, h)} ${px(p.x2, w)} ${px(p.y2, h)} ${Math.round(num(p.ms, 50, 5000))}`;
  return null;
}

// ── Logcat & network inspector ──────────────────────────────────────────────

export const logcatArgs = (tail) => ['logcat', '-v', 'threadtime', '-T', String(tail || 1)];
export const NET_LOGCAT_ARGS = ['logcat', '-v', 'raw', '-T', '5000', 'flutter:V', 'DPNET:V', '*:S'];

/**
 * Apps print `DPNET|<key>|<i>|<n>|<json chunk>` lines to logcat (see public/snippets).
 * Feed every line; returns the parsed event once all chunks of a key have arrived.
 */
export function netAssembler() {
  const partial = new Map(); // key -> { n, parts, got }
  return (line) => {
    const at = line.indexOf('DPNET|');
    if (at < 0) return null;
    const rest = line.slice(at + 6);
    const p1 = rest.indexOf('|'), p2 = rest.indexOf('|', p1 + 1), p3 = rest.indexOf('|', p2 + 1);
    if (p1 < 0 || p2 < 0 || p3 < 0) return null;
    const key = rest.slice(0, p1);
    const i = Number(rest.slice(p1 + 1, p2)), n = Number(rest.slice(p2 + 1, p3));
    if (!(n > 0 && n <= 2000 && i >= 0 && i < n)) return null;
    let e = partial.get(key);
    if (!e || e.n !== n) partial.set(key, (e = { n, parts: new Array(n), got: 0 }));
    if (e.parts[i] === undefined) e.got++;
    e.parts[i] = rest.slice(p3 + 1);
    if (e.got < n) {
      if (partial.size > 300) partial.delete(partial.keys().next().value); // drop the oldest broken one
      return null;
    }
    partial.delete(key);
    try { return JSON.parse(e.parts.join('')); } catch { return null; } // corrupted line
  };
}

// ── scrcpy ──────────────────────────────────────────────────────────────────

export const SCRCPY_JAR = '/data/local/tmp/scrcpy-server.jar';

/** Arguments after `app_process` for a tunnel_forward scrcpy session. */
export function scrcpyArgs(version, scid, opts) {
  return [
    `CLASSPATH=${SCRCPY_JAR}`, 'app_process', '/', 'com.genymobile.scrcpy.Server',
    version, `scid=${scid}`, 'log_level=info', 'tunnel_forward=true', 'audio=false', 'control=true',
    'cleanup=true', 'send_device_meta=false', 'video_codec=h264',
    `max_size=${intIn(opts.maxSize, 0, 4096, 1024)}`, `max_fps=${intIn(opts.fps, 5, 120, 30)}`,
    `video_bit_rate=${intIn(opts.bitrate, 1, 50, 4) * 1_000_000}`, 'clipboard_autosync=true',
  ];
}
export const newScid = () => Math.floor(Math.random() * 0x7fffffff).toString(16).padStart(8, '0');
