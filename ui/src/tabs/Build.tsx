import { useEffect, useRef, useState } from 'react';
import {
  Copy, FolderOpen, Hammer, Link2, Package, Play, Plus, RefreshCw, Rocket, Sparkles, Square, Trash2, Zap, X, Laptop, CircleStop,
} from 'lucide-react';
import { WEB, agent, api, useBuild, useDevices, type Project } from '../state';
import { Badge, Button, Empty, SectionHead, useBusy, useToast } from '../ui';

// [task, label, icon, variant, tooltip]
type Task = [string, string, typeof Play, 'primary' | 'secondary' | 'danger-soft', string];
const groups = (p: Project): Task[][] => [
  [
    p.type === 'flutter' ? ['run', 'flutter run', Play, 'primary', 'Debug run with hot reload'] : ['run', 'Run', Play, 'primary', 'Build, install and launch'],
    ['deploy-debug', 'Rebuild & launch', Rocket, 'secondary', 'Stop → build debug → install → launch'],
  ],
  [
    ['build-debug', 'Build debug', Hammer, 'secondary', 'Build a debug APK'],
    ['build-release', 'Build release', Hammer, 'secondary', 'Build a release APK'],
    ['install-debug', 'Install debug', Package, 'secondary', 'Install the last debug APK'],
    ['install-release', 'Install release', Package, 'secondary', 'Install the last release APK'],
  ],
  [
    ['launch', 'Launch', Play, 'secondary', 'Open the app on the phone'],
    ['stop', 'Stop app', CircleStop, 'danger-soft', 'Force-stop the app'],
    ['clean', 'Clean', Sparkles, 'secondary', 'Delete build outputs'],
  ],
];

export function Build({ active }: { active: boolean }) {
  const { available, projects, refresh, follow } = useBuild();
  const { serial } = useDevices();
  const { toast } = useToast();
  const { busy, run } = useBusy();
  const [path, setPath] = useState('');
  const [found, setFound] = useState<{ name: string; type: string; root: string }[] | null>(null);

  useEffect(() => {
    if (!active || !available) return;
    refresh();
    api('/api/projects/discover').then(setFound, () => setFound([]));
  }, [active, available, refresh]);

  if (WEB && !available) return <HelperSetup />;

  const add = (dir: string) => run(`add:${dir}`, async () => {
    const p = await api('/api/projects', { body: { path: dir } });
    toast(`Added ${p.name} (${p.type})`);
    setPath('');
    setFound((f) => f?.filter((x) => x.root !== p.root) ?? null);
    refresh();
  });
  const browse = () => run('browse', async () => {
    toast('Choose the folder in the window that opened on your PC');
    const r = await api('/api/projects/pick', { body: {} });
    if (r.path) await add(r.path);
  });
  const runTask = (p: Project, task: string) => run(`${p.id}:${task}`, async () => {
    const needsDevice = !task.startsWith('build') && task !== 'clean';
    if (needsDevice && !serial) throw new Error('Select a device first');
    const job = await api('/api/projects/run', { body: { id: p.id, task, serial: serial || undefined } });
    follow(job.id);
    setTimeout(refresh, 300);
  });

  return (
    <>
      <section>
        <SectionHead icon={FolderOpen} title="Projects">{WEB ? 'Builds run on your PC through the helper' : 'Builds run on this PC'}</SectionHead>
        <form className="toolbar" onSubmit={(e) => { e.preventDefault(); if (path.trim()) add(path.trim()); }}>
          <input className="input mono grow" placeholder="Project folder, e.g. ~/code/my_app (Flutter, Gradle or React Native)" value={path} onChange={(e) => setPath(e.target.value)} />
          <Button icon={FolderOpen} loading={busy === 'browse'} onClick={browse}>Browse…</Button>
          <Button type="submit" variant="primary" icon={Plus} disabled={!path.trim()} loading={busy === `add:${path.trim()}`}>Add</Button>
        </form>
      </section>
      {projects.map((p) => <ProjectCard key={p.id} p={p} busy={busy} onTask={(t) => runTask(p, t)} />)}
      {!projects.length && <div className="panel"><Empty icon={Hammer} title="No projects yet">Add a Flutter, native Android (Gradle) or React Native project with <b>Browse…</b>.</Empty></div>}
      <JobConsole />
      {found && found.length > 0 && (
        <section>
          <SectionHead icon={Laptop} title="Found on this PC" />
          <div className="panel">
            {found.map((f) => (
              <div key={f.root} className="found">
                <div className="grow">
                  <div className="row"><b>{f.name}</b><Badge>{f.type}</Badge></div>
                  <div className="muted small mono truncate">{f.root}</div>
                </div>
                <Button size="sm" icon={Plus} loading={busy === `add:${f.root}`} onClick={() => add(f.root)}>Add</Button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function ProjectCard({ p, busy, onTask }: { p: Project; busy: string | null; onTask: (t: string) => void }) {
  const { refresh } = useBuild();
  const { toast, fail } = useToast();
  const save = (field: 'packageId' | 'buildArgs', value: string) => {
    if (value === p[field]) return;
    api('/api/projects/update', { body: { id: p.id, [field]: value } }).then(() => { toast('Saved'); refresh(); }, fail);
  };
  return (
    <div className="project">
      <div className="project-head">
        <span className="name">{p.name}</span>
        <Badge>{p.type}</Badge>
        {p.session ? <Badge tone="success" pulse={!p.session.ready}>{p.session.ready ? 'live' : 'starting'}</Badge>
          : p.running ? <Badge tone="info" pulse>{(p.job?.step ?? 'running').replace(':', ' ')}</Badge> : null}
        <span className="spacer" />
        <Button variant="ghost" size="sm" icon={Trash2} title="Remove from list (files are not touched)" onClick={() => {
          if (confirm(`Remove ${p.name} from droidpanel? Files are not touched.`)) api('/api/projects/remove', { body: { id: p.id } }).then(refresh, fail);
        }} />
      </div>
      <div className="path">{p.root}</div>
      <div className="fields">
        <input className="input mono" defaultValue={p.packageId} placeholder="Application id, e.g. com.example.app" title="Application id" onBlur={(e) => save('packageId', e.target.value.trim())} />
        <input className="input mono" defaultValue={p.buildArgs} title="Extra build/run arguments" onBlur={(e) => save('buildArgs', e.target.value)}
          placeholder={p.type === 'flutter' ? 'Extra args, e.g. --dart-define=API_BASE_URL=http://192.168.0.10:4000' : 'Extra Gradle args'} />
      </div>
      <div className="task-groups">
        {groups(p).map((g, i) => (
          <div key={i} className="group">
            {g.map(([task, label, Icon, variant, title]) => (
              <Button key={task} size="sm" variant={variant} icon={Icon} title={title} loading={busy === `${p.id}:${task}`} disabled={p.running && task !== 'stop'} onClick={() => onTask(task)}>{label}</Button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function JobConsole() {
  const { currentJob, follow, refresh } = useBuild();
  const { toast, fail } = useToast();
  const pre = useRef<HTMLPreElement>(null);
  const [job, setJob] = useState<{ project: string; task: string; status: string; step: string | null; interactive: boolean } | null>(null);
  const from = useRef(0);

  useEffect(() => {
    from.current = 0;
    if (pre.current) pre.current.textContent = '';
    setJob(null);
    if (!currentJob) return;
    let stop = false;
    let wasRunning = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let j;
      try { j = await api(`/api/jobs/log?id=${currentJob}&from=${from.current}`); } catch { setJob(null); return; }
      if (stop) return;
      const el = pre.current;
      if (el && j.lines.length) {
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
        el.append(document.createTextNode(`${j.lines.join('\n')}\n`));
        if (el.textContent!.length > 400000) el.textContent = el.textContent!.slice(-300000);
        if (atBottom) el.scrollTop = el.scrollHeight;
      }
      from.current = j.from + j.lines.length;
      setJob(j);
      if (j.status === 'running') { wasRunning = true; timer = setTimeout(poll, 600); } else if (wasRunning) {
        toast(`${j.project}: ${j.task} ${j.status === 'ok' ? 'finished' : j.status}`, j.status === 'failed');
        refresh();
      }
    };
    poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [currentJob, toast, refresh]);

  if (!currentJob) return null;
  const running = job?.status === 'running';
  const tone = job?.status === 'ok' ? 'success' : job?.status === 'failed' ? 'danger' : running ? 'info' : undefined;
  return (
    <section>
      <div className="job-head">
        <b>{job ? `${job.project} · ${job.task}` : 'Job'}</b>
        {job && <Badge tone={tone} pulse={running}>{running && job.step ? job.step.replace(':', ' ') : job.status}</Badge>}
        <span className="spacer" />
        {running && job?.interactive && <>
          <Button size="sm" variant="warn-soft" icon={Zap} onClick={() => api('/api/jobs/input', { body: { id: currentJob, data: 'r' } }).then(() => toast('Hot reload'), fail)}>Hot reload</Button>
          <Button size="sm" icon={RefreshCw} onClick={() => api('/api/jobs/input', { body: { id: currentJob, data: 'R' } }).then(() => toast('Hot restart'), fail)}>Hot restart</Button>
        </>}
        {running && <Button size="sm" variant="danger-soft" icon={Square} onClick={() => api('/api/jobs/stop', { body: { id: currentJob } }).catch(fail)}>Stop</Button>}
        {!running && <Button size="sm" variant="ghost" icon={X} title="Hide" onClick={() => follow('')} />}
      </div>
      <pre className="console job-log scroll-thin" ref={pre} />
    </section>
  );
}

function HelperSetup() {
  const { toast, fail } = useToast();
  const { busy, run } = useBusy();
  const [hint, setHint] = useState('');
  const cmd = `npx -y github:jubairmoaj/droidpanel agent --origin ${location.origin}`;
  return (
    <div className="setup">
      <SectionHead icon={Laptop} title="Connect the PC helper" />
      <p style={{ margin: 0 }}>
        Build, run, hot reload and stop run on <b>your PC</b> in the background, using its Flutter/Gradle. The helper idles until you click a task,
        only accepts this panel, and listens on your PC only.
      </p>
      <ol className="steps">
        <li>Open a terminal on the PC where your code is (needs Node.js 20+ and the Flutter/Android SDK).</li>
        <li>Run this command and keep it open:</li>
      </ol>
      <pre className="console">{cmd}</pre>
      <div className="toolbar">
        <Button icon={Copy} onClick={() => navigator.clipboard.writeText(cmd).then(() => toast('Command copied'), fail)}>Copy command</Button>
        <Button variant="primary" icon={Link2} loading={busy === 'connect'} onClick={() => run('connect', async () => {
          agent!.connect();
          try {
            await agent!.status();
            setHint('');
          } catch (e) {
            setHint('Not reachable. If the helper is running, allow this site to access apps on this device (lock icon in the address bar → Site settings), then press Connect again.');
            throw e;
          }
        })}>Connect</Button>
      </div>
      {hint && <div className="note warn"><Link2 /><span>{hint}</span></div>}
    </div>
  );
}
