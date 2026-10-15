// Build & Run routes, shared by the local server (src/server.mjs) and the PC helper (src/agent.mjs).
import os from 'node:os';
import * as P from './projects.mjs';
import { HttpError, exec, which } from './util.mjs';

/** Open the OS folder picker on this PC. Resolves with the chosen path, or null if cancelled. */
async function pickFolder() {
  const title = 'Choose your app folder';
  let r;
  if (process.platform === 'darwin') {
    r = await exec('osascript', ['-e', `POSIX path of (choose folder with prompt "${title}")`], { timeout: 300000 });
  } else if (process.platform === 'win32') {
    r = await exec('powershell', ['-NoProfile', '-STA', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; '
      + `$f.Description = '${title}'; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }`], { timeout: 300000 });
  } else if (which('zenity')) {
    r = await exec('zenity', ['--file-selection', '--directory', `--title=${title}`, `--filename=${os.homedir()}/`], { timeout: 300000 });
  } else if (which('kdialog')) {
    r = await exec('kdialog', ['--getexistingdirectory', os.homedir(), '--title', title], { timeout: 300000 });
  } else {
    throw new HttpError(501, 'No folder picker on this PC (install zenity) — type the path instead');
  }
  const picked = (r.stdout ?? '').trim().replace(/\/$/, '');
  return picked || null;
}

export function projectRoutes(route) {
  route('GET', '/api/projects', () => ({ projects: P.listProjects(), jobs: P.listJobs() }));
  route('POST', '/api/projects', (u, b) => P.addProject(String(b.path ?? '')));
  route('GET', '/api/projects/discover', () => P.discoverProjects());
  route('POST', '/api/projects/pick', async () => ({ path: await pickFolder() }));
  route('POST', '/api/projects/update', (u, b) => P.updateProject(b.id, b));
  route('POST', '/api/projects/remove', async (u, b) => { await P.removeProject(b.id); return { ok: true }; });
  route('POST', '/api/projects/run', (u, b) => P.startJob(b.id, b.task, b.serial));
  route('GET', '/api/jobs/log', (u) => P.jobLog(u.searchParams.get('id'), Number(u.searchParams.get('from') ?? 0)));
  route('POST', '/api/jobs/stop', (u, b) => { P.stopJob(b.id); return { ok: true }; });
  route('POST', '/api/jobs/input', (u, b) => { P.jobInput(b.id, String(b.data ?? '')); return { ok: true }; });
}
