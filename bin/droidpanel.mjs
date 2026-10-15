#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createApp, shutdown, log } from '../src/server.mjs';
import { loadConfig } from '../src/projects.mjs';
import { createWebApp, resolveScrcpy } from '../src/web.mjs';
import { startAgent } from '../src/agent.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

if (flag('help') || flag('h')) {
  console.log(`droidpanel — web dashboard for Android development

Usage: droidpanel [--port 4321] [--host 127.0.0.1] [--no-open]
       droidpanel --web [--port 4321] [--host 0.0.0.0]

  --web   Hosted mode for a server/VPS: serves the UI only. Each visitor's browser
          talks to their own phone over WebUSB, so nothing runs on their computer.
          Put it behind HTTPS (WebUSB requires it), e.g. Caddy or nginx.

       droidpanel agent --origin https://panel.example.com [--port 4322] [--relay-port 5038]

  agent   PC helper for hosted mode: runs Build & Run (flutter/gradle) on this PC when
          you click it in the hosted page. adb traffic goes through the browser's USB link.

Environment:
  ADB=/path/to/adb            adb binary (default: adb on PATH)
  SCRCPY_SERVER=/path/to/scrcpy-server   override scrcpy-server location
  DROIDPANEL_HOME=~/.config/droidpanel    where projects are saved`);
  process.exit(0);
}

async function runAgent() {
  const origins = new Set((opt('origin', process.env.DROIDPANEL_ORIGIN ?? '')).split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean));
  if (!origins.size) {
    console.error('Tell the agent which panel may use it, e.g.:\n  droidpanel agent --origin https://panel.example.com');
    process.exit(1);
  }
  await loadConfig();
  const port = Number(opt('port', 4322));
  const relayPort = Number(opt('relay-port', 5038));
  try {
    const agent = await startAgent({ port, relayPort, origins, log: (l) => console.log(`${new Date().toLocaleTimeString()} ${l}`) });
    console.log(`\n  droidpanel agent ready on http://127.0.0.1:${port}\n  Allowed panel: ${[...origins].join(', ')}\n  Ctrl+C to stop\n`);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { agent.stop(); process.exit(0); });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

async function runPanel() {
  const port = Number(opt('port', process.env.PORT ?? 4321));
  const web = flag('web');
  const host = opt('host', web ? '0.0.0.0' : '127.0.0.1');

  let server;
  if (web) {
    server = createWebApp({ scrcpy: await resolveScrcpy() });
  } else {
    await loadConfig();
    server = createApp({ port, host });
  }
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is busy — try --port ${port + 1}` : e.message);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  droidpanel ${web ? 'hosted mode ' : ''}running → ${url}\n  Ctrl+C to stop\n`);
    if (web) return console.log(`  Listening on ${host}:${port}. Serve it over HTTPS — WebUSB only works on https:// (or localhost).\n`);
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
}

if (argv[0] === 'agent') await runAgent();
else await runPanel();
