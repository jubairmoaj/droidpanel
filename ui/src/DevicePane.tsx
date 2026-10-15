// Left pane: live mirror of the selected phone, its controls, and the quick Build bar.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Bell, Camera, ChevronLeft, Circle, Download, Maximize2, Minimize2, Play, Power, RotateCw, Smartphone, Square,
  Volume1, Volume2, Zap, RefreshCw, Rocket, CircleStop, X, CircleDot,
} from 'lucide-react';
import { Mirror } from './core/mirror.js';
import { WEB, api, apiFetch } from './core/api.js';
import { useBuild, useDevices } from './state';
import { Badge, Button, downloadUrl, stamp, store, useBusy, useToast } from './ui';

const QUALITIES = [
  { value: '720,30,2', label: 'Lite · 720p' },
  { value: '1024,30,4', label: 'Balanced · 1024p' },
  { value: '1600,60,8', label: 'Sharp · 1600p 60' },
];

type MirrorState = 'off' | 'connecting' | 'live';

export function DevicePane() {
  const { serial, ready, device, scrcpy } = useDevices();
  const { toast, fail } = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<Mirror | null>(null);
  const [state, setState] = useState<MirrorState>('off');
  const [stats, setStats] = useState('');
  const [frame, setFrame] = useState<[number, number] | null>(null);
  const [box, setBox] = useState<[number, number]>([0, 0]);
  const [quality, setQuality] = useState(store.get('quality', '1024,30,4'));
  const [full, setFull] = useState(false);

  // One Mirror engine for the lifetime of the pane.
  useEffect(() => {
    const m = new Mirror({
      canvas: canvasRef.current!,
      toast: (t: string) => toast(t),
      onStats: setStats,
      onFrameSize: (w: number, h: number) => setFrame([w, h]),
      onState: (s: string, msg?: string) => {
        if (s === 'connecting') setState('connecting');
        else if (s === 'live') { setState('live'); canvasRef.current?.focus(); }
        else {
          setState('off');
          setFrame(null);
          setStats('');
          if (s === 'error') fail(new Error(`Mirror: ${msg}`));
          if (s === 'ended') toast('Mirror ended — phone disconnected or locked?');
        }
      },
    });
    mirrorRef.current = m;
    return () => m.stop();
  }, [toast, fail]);

  // Stop when the device changes.
  useEffect(() => {
    const m = mirrorRef.current!;
    m.stop();
    m.serial = serial || null;
  }, [serial]);

  // Fit the video inside the stage (contain) — never cropped, whatever the phone's aspect ratio.
  useLayoutEffect(() => {
    const el = stageRef.current!;
    const ro = new ResizeObserver(([e]) => setBox([e.contentRect.width, e.contentRect.height]));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pad = full ? 0 : 24;
  const scale = frame ? Math.min((box[0] - pad) / frame[0], (box[1] - pad) / frame[1]) : 0;
  const canvasStyle = frame && scale > 0
    ? { width: Math.floor(frame[0] * scale), height: Math.floor(frame[1] * scale), visibility: state === 'live' ? 'visible' as const : 'hidden' as const }
    : { width: 0, height: 0, visibility: 'hidden' as const };

  useEffect(() => {
    const onFs = () => setFull(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const start = () => {
    if (!ready) return fail(new Error('Connect a device first'));
    mirrorRef.current!.start(serial, quality, scrcpy.available);
  };
  const toggle = () => (state === 'off' ? start() : mirrorRef.current!.stop());
  const changeQuality = (q: string) => {
    setQuality(q);
    store.set('quality', q);
    if (state !== 'off') mirrorRef.current!.start(serial, q, scrcpy.available);
  };
  const key = (code: number) => {
    if (!serial) return fail(new Error('Select a device first'));
    if (code === 4) mirrorRef.current!.backOrScreenOn(); else mirrorRef.current!.key(code);
  };

  return (
    <aside className="card device-pane">
      <div className="pane-bar">
        <Button variant={state === 'off' ? 'primary' : 'danger-soft'} icon={state === 'off' ? Play : Square} onClick={toggle} disabled={!ready && state === 'off'}>
          {state === 'off' ? 'Mirror' : 'Stop'}
        </Button>
        <select className="select" value={quality} onChange={(e) => changeQuality(e.target.value)} aria-label="Mirror quality">
          {QUALITIES.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
        </select>
        <span className="spacer" />
        <Capture />
      </div>
      <QuickBar />
      <div className="stage" ref={stageRef}>
        <canvas ref={canvasRef} tabIndex={0} style={canvasStyle} />
        {state !== 'live' && (
          <div className="stage-empty">
            <div className="phone"><Smartphone size={26} /></div>
            {state === 'connecting' ? (
              <><h4>Starting mirror…</h4><p>Connecting to {device?.model || 'the phone'}</p></>
            ) : ready ? (
              <><h4>{device?.model || serial}</h4><p>Press <b>Mirror</b> to see and control the screen.</p>
                <Button variant="primary" icon={Play} onClick={start}>Start mirror</Button></>
            ) : (
              <><h4>No device</h4><p>Plug in your phone with USB debugging on, then use <b>Connect device</b>.</p></>
            )}
          </div>
        )}
        {state === 'live' && (
          <div className="stage-float">
            <Button size="sm" icon={full ? Minimize2 : Maximize2} title={full ? 'Exit full screen' : 'Full screen'}
              onClick={() => (full ? document.exitFullscreen() : stageRef.current!.requestFullscreen())} />
          </div>
        )}
      </div>
      <div className="nav-bar">
        <Button variant="ghost" icon={ChevronLeft} title="Back (right-click)" onClick={() => key(4)} />
        <Button variant="ghost" icon={Circle} title="Home (middle-click)" onClick={() => key(3)} />
        <Button variant="ghost" icon={Square} title="Recent apps" onClick={() => key(187)} />
        <span className="sep" />
        <Button variant="ghost" icon={Volume1} title="Volume down" onClick={() => key(25)} />
        <Button variant="ghost" icon={Volume2} title="Volume up" onClick={() => key(24)} />
        <Button variant="ghost" icon={Power} title="Power / lock" onClick={() => key(26)} />
        <span className="sep" />
        <Button variant="ghost" icon={Bell} title="Notifications" onClick={() => mirrorRef.current!.notifications()} />
        <Button variant="ghost" icon={RotateCw} title="Rotate" onClick={() => mirrorRef.current!.rotate()} />
      </div>
      <div className="pane-foot">
        <span>{state === 'live' ? stats || 'Live' : state === 'connecting' ? 'Connecting…' : 'Mirror off'}</span>
        <span className="hide-sm truncate" title="Click = tap · drag = swipe · wheel = scroll · right-click = back · middle-click = home · type to send keys · Ctrl+V pastes">Right-click back · type to send keys</span>
      </div>
    </aside>
  );
}

/** Screenshot to clipboard / save, and screen recording. */
function Capture() {
  const { serial } = useDevices();
  const { toast, fail } = useToast();
  const { busy, run } = useBusy();
  const [recAt, setRecAt] = useState<number | null>(null);
  const [, tick] = useState(0);

  const shotBlob = useCallback(() => apiFetch(`/api/screenshot?serial=${encodeURIComponent(serial)}`).then(async (r: Response) => {
    if (!r.ok) throw new Error((await r.json()).error);
    return r.blob();
  }), [serial]);

  const copy = useCallback(async () => {
    if (!serial) return fail(new Error('Select a device first'));
    const blob = shotBlob();
    try {
      // Passing a promise keeps the user gesture alive while the PNG arrives.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Screenshot copied to clipboard');
    } catch {
      try {
        await blob;
        const r = await api('/api/screenshot/copy', { body: { serial } });
        toast(`Screenshot copied (via ${r.via})`);
      } catch (e) { fail(e); }
    }
  }, [serial, shotBlob, toast, fail]);

  const save = () => run('save', async () => {
    const url = URL.createObjectURL(await shotBlob());
    downloadUrl(url, `screenshot-${stamp()}.png`);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); copy(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [copy]);

  useEffect(() => {
    setRecAt(null);
    if (!serial) return;
    api(`/api/record?serial=${encodeURIComponent(serial)}`).then((r: { recording: boolean; startedAt: number }) => setRecAt(r.recording ? r.startedAt : null), () => {});
  }, [serial]);
  useEffect(() => {
    if (!recAt) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [recAt]);

  const record = () => run('rec', async () => {
    if (!serial) throw new Error('Select a device first');
    if (recAt) {
      toast('Saving recording…');
      const r = await api('/api/record/stop', { body: { serial } });
      setRecAt(null);
      if (WEB) downloadUrl(r.file, `recording-${stamp()}.mp4`);
      else downloadUrl(r.file);
    } else {
      const r = await api('/api/record/start', { body: { serial } });
      setRecAt(r.startedAt);
      toast('Recording… Android stops a recording after 3 minutes');
    }
  });
  const secs = recAt ? Math.floor((Date.now() - recAt) / 1000) : 0;

  return (
    <div className="btn-group">
      <Button icon={Camera} onClick={copy} title="Screenshot → clipboard (Ctrl+Shift+S)" aria-label="Screenshot to clipboard" disabled={!serial} />
      <Button icon={Download} onClick={save} loading={busy === 'save'} title="Save screenshot as PNG" aria-label="Save screenshot" disabled={!serial} />
      <Button variant={recAt ? 'danger' : 'danger-soft'} icon={recAt ? Square : CircleDot} onClick={record} loading={busy === 'rec'} disabled={!serial}
        title={recAt ? 'Stop and download the recording' : 'Record the screen (max 3 min)'}>
        {recAt ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : 'Rec'}
      </Button>
    </div>
  );
}

/** Run / hot reload / rebuild / stop the chosen project without leaving the mirror. */
function QuickBar() {
  const { available, projects, quickId, setQuickId, follow, refresh } = useBuild();
  const { serial } = useDevices();
  const { toast } = useToast();
  const { busy, run } = useBusy();
  const p = projects.find((x) => x.id === quickId);

  const act = (a: string) => run(a, async () => {
    if (!p) return;
    const needSerial = () => { if (!serial) throw new Error('Select a device first'); return serial; };
    if (a === 'run' || a === 'deploy') {
      const job = await api('/api/projects/run', { body: { id: p.id, task: a === 'run' ? 'run' : 'deploy-debug', serial: needSerial() } });
      follow(job.id);
    } else if (a === 'reload' || a === 'restart') {
      await api('/api/jobs/input', { body: { id: p.session!.id, data: a === 'reload' ? 'r' : 'R' } });
      toast(a === 'reload' ? 'Hot reload' : 'Hot restart');
    } else if (a === 'quit') {
      await api('/api/jobs/stop', { body: { id: (p.session ?? p.job)!.id } });
    } else if (a === 'stopApp') {
      if (!p.packageId) throw new Error('Set the application id in Build & Run first');
      const r = await api('/api/app', { body: { serial: needSerial(), pkg: p.packageId, action: 'stop' } });
      if (!r.ok) throw new Error(r.output);
      toast(`Stopped ${p.name}`);
    }
    setTimeout(refresh, 300);
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.key.toLowerCase() !== 'r' || !p?.session) return;
      e.preventDefault();
      act(e.shiftKey ? 'restart' : 'reload');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (!available || !projects.length) return null;
  const autoToggle = (on: boolean) => api('/api/projects/update', { body: { id: p!.id, autoReload: on } })
    .then(() => { toast(on ? 'Auto reload on save: on' : 'Auto reload on save: off'); refresh(); });

  return (
    <div className="quick-bar">
      <select className="select" value={quickId} onChange={(e) => setQuickId(e.target.value)} aria-label="Project">
        {projects.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.type}</option>)}
      </select>
      {p?.session ? (
        <>
          <Badge tone={p.session.ready ? 'success' : 'info'} pulse={!p.session.ready}>{p.session.ready ? `live${p.session.reloads ? ` · ${p.session.reloads}` : ''}` : 'starting'}</Badge>
          <Button size="sm" variant="warn-soft" icon={Zap} loading={busy === 'reload'} onClick={() => act('reload')} title="Hot reload (Alt+R)">Reload</Button>
          <Button size="sm" icon={RefreshCw} loading={busy === 'restart'} onClick={() => act('restart')} title="Hot restart (Alt+Shift+R)" />
          <Button size="sm" variant="danger-soft" icon={X} onClick={() => act('quit')} title="End the flutter run session" />
        </>
      ) : p?.job ? (
        <>
          <Badge tone="info" pulse>{(p.job.step ?? 'starting').replace(':', ' ')}</Badge>
          <Button size="sm" variant="danger-soft" icon={X} onClick={() => act('quit')}>Cancel</Button>
        </>
      ) : p ? (
        <>
          {p.type === 'flutter' && <Button size="sm" variant="primary" icon={Play} loading={busy === 'run'} onClick={() => act('run')} title="flutter run with hot reload">Run</Button>}
          <Button size="sm" icon={Rocket} loading={busy === 'deploy'} onClick={() => act('deploy')} title="Build debug APK → install → launch">{p.type === 'flutter' ? 'Rebuild' : 'Run'}</Button>
          <Button size="sm" variant="danger-soft" icon={CircleStop} loading={busy === 'stopApp'} onClick={() => act('stopApp')} title="Force-stop the app" />
        </>
      ) : null}
      {p?.type === 'flutter' && (
        <label className="check small" title="Hot reload when you save a .dart file">
          <input type="checkbox" checked={p.autoReload} onChange={(e) => autoToggle(e.target.checked)} /> Auto
        </label>
      )}
    </div>
  );
}
