#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createApp, shutdown, log } from '../src/server.mjs';
import { loadConfig } from '../src/projects.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

if (flag('help') || flag('h')) {
  console.log(`droidpanel — web dashboard for Android development

Usage: droidpanel [--port 4321] [--host 127.0.0.1] [--no-open]

Environment:
  ADB=/path/to/adb            adb binary (default: adb on PATH)
  SCRCPY_SERVER=/path/to/scrcpy-server   override scrcpy-server location
  DROIDPANEL_HOME=~/.config/droidpanel    where projects are saved`);
  process.exit(0);
}

const port = Number(opt('port', process.env.PORT ?? 4321));
const host = opt('host', '127.0.0.1');

await loadConfig();
const server = createApp({ port, host });
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is busy — try --port ${port + 1}` : e.message);
  process.exit(1);
});
server.listen(port, host, () => {
  const url = `http://localhost:${port}`;
  console.log(`\n  droidpanel running → ${url}\n  Ctrl+C to stop\n`);
  log(`started on ${url}`);
  if (!flag('no-open')) {
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await shutdown();
    process.exit(0);
  });
}
