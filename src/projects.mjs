// Projects (Flutter / Gradle / React Native) and the job runner that builds and deploys them.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ADB, adbArgs, shell } from './adb.mjs';
import { HttpError, onLines, splitArgs, stripAnsi } from './util.mjs';

// ── Config ──────────────────────────────────────────────────────────────────

const CONFIG_DIR = process.env.DROIDPANEL_HOME
  ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'droidpanel');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
let config = { projects: [] };

export async function loadConfig() {
  try {
    config = { projects: [], ...JSON.parse(await readFile(CONFIG_FILE, 'utf8')) };
  } catch { /* first run */ }
}
async function saveConfig() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ── Detection ───────────────────────────────────────────────────────────────

function readIf(p) {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}
function applicationId(androidDir) {
  for (const f of ['app/build.gradle.kts', 'app/build.gradle']) {
    const m = readIf(path.join(androidDir, f)).match(/applicationId\s*=?\s*["']([^"']+)["']/);
    if (m) return m[1];
  }
  const manifest = readIf(path.join(androidDir, 'app/src/main/AndroidManifest.xml'));
  return manifest.match(/package="([^"]+)"/)?.[1] ?? '';
}

export function detectProject(dir) {
  const root = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new HttpError(400, `Not a folder: ${root}`);
  const name = path.basename(root);
  if (existsSync(path.join(root, 'pubspec.yaml'))) {
    const pub = readIf(path.join(root, 'pubspec.yaml'));
    return { type: 'flutter', name: pub.match(/^name:\s*(\S+)/m)?.[1] ?? name, root, androidDir: path.join(root, 'android') };
  }
  const pkgJson = readIf(path.join(root, 'package.json'));
  if (pkgJson.includes('"react-native"') && existsSync(path.join(root, 'android'))) {
    return { type: 'react-native', name, root, androidDir: path.join(root, 'android') };
  }
  if (['gradlew', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].some((f) => existsSync(path.join(root, f)))) {
    return { type: 'android', name, root, androidDir: root };
  }
  throw new HttpError(400, 'No Flutter (pubspec.yaml), React Native or Gradle project found in that folder');
}

// Scan common folders for app projects so the user can add them in one click.
const SKIP_DIRS = new Set(['node_modules', 'build', '.dart_tool', '.gradle', 'Pods', 'ios', 'web', 'linux', 'macos', 'windows', 'Library', 'snap']);
export function discoverProjects() {
  const home = os.homedir();
  const roots = ['Documents', 'Projects', 'projects', 'code', 'Code', 'dev', 'src', 'StudioProjects', 'AndroidStudioProjects', 'Desktop', 'workspace']
    .map((d) => path.join(home, d)).filter((d) => existsSync(d));
  const known = new Set(config.projects.map((p) => p.root));
  const found = [];
  const deadline = Date.now() + 3000;
  const walk = (dir, depth) => {
    if (found.length >= 60 || Date.now() > deadline) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((e) => e.name));
    const isFlutterApp = names.has('pubspec.yaml') && names.has('android');
    const isGradleApp = names.has('gradlew') && names.has('app') && !names.has('pubspec.yaml');
    const isRnApp = names.has('package.json') && names.has('android') && readIf(path.join(dir, 'package.json')).includes('"react-native"');
    if (isFlutterApp || isGradleApp || isRnApp) {
      if (!known.has(dir)) {
        try { found.push({ ...detectProject(dir), root: dir }); } catch { /* not a project after all */ }
      }
      return; // don't descend into a project
    }
    if (depth >= 4) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  roots.forEach((r) => walk(r, 0));
  return found.map(({ name, type, root }) => ({ name, type, root }));
}

export const listProjects = () => config.projects.map(decorate);
function decorate(p) {
  const running = [...jobs.values()].filter((j) => j.projectId === p.id && j.status === 'running');
  const live = running.find((j) => j.interactive);
  return {
    ...p,
    autoReload: p.autoReload !== false,
    running: running.length > 0,
    job: running[0] ? { id: running[0].id, task: running[0].task, step: running[0].step } : null,
    session: live ? { id: live.id, ready: Boolean(live.ready), reloads: live.reloads ?? 0 } : null,
  };
}

export async function addProject(dir) {
  const d = detectProject(dir);
  const existing = config.projects.find((p) => p.root === d.root);
  if (existing) return existing;
  const project = {
    id: randomBytes(4).toString('hex'),
    name: d.name,
    type: d.type,
    root: d.root,
    androidDir: d.androidDir,
    packageId: applicationId(d.androidDir),
    buildArgs: '',
  };
  config.projects.push(project);
  await saveConfig();
  return project;
}

export async function updateProject(id, patch) {
  const p = getProject(id);
  if (typeof patch.buildArgs === 'string') p.buildArgs = patch.buildArgs;
  if (typeof patch.packageId === 'string') p.packageId = patch.packageId.trim();
  if (typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim();
  if (typeof patch.autoReload === 'boolean') p.autoReload = patch.autoReload;
  await saveConfig();
  return p;
}

export async function removeProject(id) {
  config.projects = config.projects.filter((p) => p.id !== id);
  await saveConfig();
}

function getProject(id) {
  const p = config.projects.find((x) => x.id === id);
  if (!p) throw new HttpError(404, 'Project not found');
  return p;
}

// ── Tasks ───────────────────────────────────────────────────────────────────

const gradlew = (dir) => (process.platform === 'win32' ? path.join(dir, 'gradlew.bat') : path.join(dir, 'gradlew'));

// Flutter debug APKs are built for 3 CPU ABIs by default; building only the phone's is much faster.
const FLUTTER_PLATFORM = { 'arm64-v8a': 'android-arm64', 'armeabi-v7a': 'android-arm', x86_64: 'android-x64' };

function buildCommand(p, mode, abi) {
  const extra = splitArgs(p.buildArgs);
  if (p.type === 'flutter') {
    const target = FLUTTER_PLATFORM[abi] && !extra.some((a) => a.startsWith('--target-platform'))
      ? ['--target-platform', FLUTTER_PLATFORM[abi]] : [];
    return { cmd: 'flutter', args: ['build', 'apk', `--${mode}`, ...target, ...extra], cwd: p.root };
  }
  const task = mode === 'release' ? 'assembleRelease' : 'assembleDebug';
  return { cmd: gradlew(p.androidDir), args: [task, ...extra], cwd: p.androidDir };
}

function findApk(p, mode) {
  const dirs = p.type === 'flutter'
    ? [path.join(p.root, 'build/app/outputs/flutter-apk')]
    : [path.join(p.androidDir, 'app/build/outputs/apk', mode)];
  let best = null;
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.name.endsWith('.apk') && (p.type !== 'flutter' || e.name === `app-${mode}.apk`)) {
        const t = statSync(full).mtimeMs;
        if (!best || t > best.t) best = { file: full, t };
      }
    }
  };
  dirs.forEach((d) => walk(d, 0));
  return best?.file ?? null;
}

const TASKS = {
  'deploy-debug': ['build:debug', 'install:debug', 'launch'],
  'build-debug': ['build:debug'],
  'build-release': ['build:release'],
  'install-debug': ['install:debug'],
  'install-release': ['install:release'],
  'deploy-release': ['build:release', 'install:release', 'launch'],
  launch: ['launch'],
  stop: ['stop'],
  run: ['run'],
  clean: ['clean'],
};
export const TASK_NAMES = Object.keys(TASKS);

// ── Jobs ────────────────────────────────────────────────────────────────────

const jobs = new Map(); // id -> job
const MAX_LINES = 8000;

export function listJobs() {
  return [...jobs.values()].slice(-20).reverse().map(summary);
}
const summary = (j) => ({
  id: j.id, projectId: j.projectId, project: j.projectName, task: j.task, serial: j.serial,
  status: j.status, step: j.step, startedAt: j.startedAt, endedAt: j.endedAt, interactive: j.interactive, ready: Boolean(j.ready), lines: j.offset + j.log.length,
});

export function jobLog(id, from = 0) {
  const j = jobs.get(id);
  if (!j) throw new HttpError(404, 'Job not found');
  const start = Math.max(0, from - j.offset);
  return { ...summary(j), from: j.offset + start, lines: j.log.slice(start) };
}

export function stopJob(id) {
  const j = jobs.get(id);
  if (!j) throw new HttpError(404, 'Job not found');
  j.cancelled = true;
  j.proc?.kill('SIGINT');
  setTimeout(() => j.proc?.kill('SIGKILL'), 4000).unref();
}

export function jobInput(id, data) {
  const j = jobs.get(id);
  if (!j?.proc?.stdin?.writable) throw new HttpError(409, 'Job does not accept input');
  if (!/^[rRqpPowdcLSUiIa]$/.test(data)) throw new HttpError(400, 'Unsupported key');
  j.proc.stdin.write(data);
}

export function startJob(projectId, task, serial) {
  const p = getProject(projectId);
  if (!TASKS[task]) throw new HttpError(400, 'Unknown task');
  if ([...jobs.values()].some((j) => j.projectId === p.id && j.status === 'running')) {
    throw new HttpError(409, 'A job is already running for this project');
  }
  const job = {
    id: randomBytes(4).toString('hex'), projectId: p.id, projectName: p.name, task, serial,
    status: 'running', step: null, startedAt: Date.now(), endedAt: null, log: [], offset: 0,
    interactive: task === 'run' && p.type === 'flutter', proc: null, cancelled: false,
  };
  jobs.set(job.id, job);
  if (jobs.size > 30) jobs.delete(jobs.keys().next().value);
  runSteps(job, p, TASKS[task]).then(
    (ok) => finish(job, ok),
    (e) => { append(job, `✘ ${e.message}`); finish(job, false); },
  );
  return summary(job);
}

// Hot-reload a running `flutter run` session whenever a .dart file under lib/ is saved.
function watchForReload(job, p) {
  let timer = null;
  try {
    return watch(path.join(p.root, 'lib'), { recursive: true }, (_ev, file) => {
      if (!file?.endsWith('.dart')) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const project = config.projects.find((x) => x.id === p.id);
        if (!job.ready || !job.proc?.stdin?.writable || project?.autoReload === false) return;
        append(job, `⚡ ${file} saved — hot reload`);
        job.reloads = (job.reloads ?? 0) + 1;
        job.proc.stdin.write('r');
      }, 350);
    });
  } catch (e) {
    append(job, `(auto reload unavailable: ${e.message})`);
    return null;
  }
}

function append(job, line) {
  // `flutter run` prints its key help once the app is up; from then on reloads work.
  if (job.interactive && !job.ready && /hot reload|key commands/i.test(line)) job.ready = true;
  job.log.push(stripAnsi(line));
  if (job.log.length > MAX_LINES) {
    const drop = job.log.length - MAX_LINES;
    job.log.splice(0, drop);
    job.offset += drop;
  }
}

function finish(job, ok) {
  job.status = job.cancelled ? 'stopped' : ok ? 'ok' : 'failed';
  job.endedAt = Date.now();
  job.proc = null;
  const secs = ((job.endedAt - job.startedAt) / 1000).toFixed(1);
  append(job, job.status === 'ok' ? `✔ Done in ${secs}s` : job.status === 'stopped' ? '■ Stopped' : `✘ Failed after ${secs}s`);
}

function runProc(job, cmd, args, cwd, { stdin = false } = {}) {
  return new Promise((resolve) => {
    append(job, `$ ${[cmd, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    let proc;
    try {
      proc = spawn(cmd, args, { cwd, env: { ...process.env, TERM: 'dumb' }, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (e) {
      append(job, `✘ ${e.message}`);
      return resolve(false);
    }
    job.proc = proc;
    onLines(proc.stdout, (l) => append(job, l));
    onLines(proc.stderr, (l) => append(job, l));
    proc.on('error', (e) => { append(job, `✘ ${e.code === 'ENOENT' ? `${cmd} not found on PATH` : e.message}`); resolve(false); });
    proc.on('close', (code) => { job.proc = null; resolve(code === 0); });
  });
}

async function runSteps(job, p, steps) {
  const adb = (args) => runProc(job, ADB, adbArgs(job.serial, args));
  for (const step of steps) {
    if (job.cancelled) return false;
    job.step = step;
    append(job, `── ${step} ──`);
    const [kind, mode] = step.split(':');
    let ok = true;
    if (kind === 'build') {
      const abi = job.serial ? (await shell(job.serial, 'getprop ro.product.cpu.abi')).stdout.trim() : '';
      const { cmd, args, cwd } = buildCommand(p, mode, abi);
      ok = await runProc(job, cmd, args, cwd);
    } else if (kind === 'install') {
      const apk = findApk(p, mode);
      if (!apk) {
        append(job, `✘ No ${mode} APK found — build it first`);
        return false;
      }
      ok = await adb(['install', '-r', '-t', apk]);
    } else if (kind === 'launch' || kind === 'stop') {
      if (!p.packageId) {
        append(job, '✘ Package id unknown — set it in the project settings');
        return false;
      }
      ok = kind === 'launch'
        ? await adb(['shell', 'monkey', '-p', p.packageId, '-c', 'android.intent.category.LAUNCHER', '1'])
        : await adb(['shell', 'am', 'force-stop', p.packageId]);
    } else if (kind === 'run') {
      if (p.type === 'flutter') {
        const watcher = p.autoReload !== false ? watchForReload(job, p) : null;
        ok = await runProc(job, 'flutter', ['run', ...(job.serial ? ['-d', job.serial] : []), ...splitArgs(p.buildArgs)], p.root, { stdin: true });
        watcher?.close();
      } else if (p.type === 'react-native') {
        ok = await runProc(job, 'npx', ['react-native', 'run-android', ...(job.serial ? ['--deviceId', job.serial] : [])], p.root);
      } else {
        ok = await runSteps(job, p, ['build:debug', 'install:debug', 'launch']);
      }
    } else if (kind === 'clean') {
      ok = p.type === 'flutter'
        ? await runProc(job, 'flutter', ['clean'], p.root)
        : await runProc(job, gradlew(p.androidDir), ['clean'], p.androidDir);
    }
    if (!ok) return false;
  }
  return true;
}

export const stopAllJobs = () => {
  for (const j of jobs.values()) j.proc?.kill('SIGINT');
};
