import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Eraser, Pause, Play, Save, Search, Square, Package } from 'lucide-react';
import { api, apiEvents } from '../core/api.js';
import { useDevices } from '../state';
import { Button, downloadUrl, stamp, useToast } from '../ui';

const LEVELS = 'VDIWEF';
const LINE_RE = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*)$/;
const MAX_BUFFER = 30000;
const MAX_DOM = 4000;
type Line = { raw: string; pid: string | null; level: string };
const parse = (raw: string): Line => {
  const m = LINE_RE.exec(raw);
  return m ? { raw, pid: m[2], level: m[4] === 'A' ? 'F' : m[4] } : { raw, pid: null, level: 'V' };
};

export type LogcatHandle = { showPackage: (pkg: string) => void };

// The view is updated imperatively: thousands of lines per minute are too many for React re-renders.
export function Logcat({ ref, apps }: { ref?: Ref<LogcatHandle>; apps: string[] }) {
  const { serial, ready } = useDevices();
  const { toast, fail } = useToast();
  const view = useRef<HTMLPreElement>(null);
  const buffer = useRef<Line[]>([]);
  const pids = useRef(new Set<string>());
  const source = useRef<{ close: () => void } | null>(null);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [pkg, setPkg] = useState('');
  const [level, setLevel] = useState('V');
  const [query, setQuery] = useState('');
  const [count, setCount] = useState('');
  const filterRef = useRef({ pkg, level, query });
  filterRef.current = { pkg, level, query };

  const makeFilter = () => {
    const { pkg: p, level: lv, query: q } = filterRef.current;
    const min = LEVELS.indexOf(lv);
    let re: RegExp | null = null;
    if (q) { try { re = new RegExp(q, 'i'); } catch { re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } }
    return { re, test: (l: Line) => LEVELS.indexOf(l.level) >= min && (!p || (l.pid !== null && pids.current.has(l.pid))) && (!re || re.test(l.raw)) };
  };

  const lineEl = (l: Line, re: RegExp | null) => {
    const div = document.createElement('div');
    div.className = `l-${l.level}`;
    if (!re) { div.textContent = l.raw; return div; }
    const g = new RegExp(re.source, 'gi');
    let last = 0;
    for (const m of l.raw.matchAll(g)) {
      if (!m[0]) break;
      div.append(l.raw.slice(last, m.index));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      div.append(mark);
      last = m.index! + m[0].length;
    }
    div.append(l.raw.slice(last));
    return div;
  };

  const render = (full: boolean, added: Line[] = []) => {
    const el = view.current;
    if (!el) return;
    const f = makeFilter();
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    const frag = document.createDocumentFragment();
    if (full) {
      el.textContent = '';
      buffer.current.filter(f.test).slice(-MAX_DOM).forEach((l) => frag.append(lineEl(l, f.re)));
    } else added.filter(f.test).forEach((l) => frag.append(lineEl(l, f.re)));
    el.append(frag);
    while (el.childElementCount > MAX_DOM) el.firstElementChild!.remove();
    setCount(`${el.childElementCount.toLocaleString()} shown · ${buffer.current.length.toLocaleString()} buffered`);
    if (atBottom || full) el.scrollTop = el.scrollHeight;
  };

  const refreshPids = async () => {
    const p = filterRef.current.pkg.trim();
    if (!p || !serial) { pids.current = new Set(); return; }
    try {
      const d = await api(`/api/app?serial=${encodeURIComponent(serial)}&pkg=${encodeURIComponent(p)}`);
      const before = pids.current.size;
      d.pids.forEach((x: string) => pids.current.add(x)); // keep old pids so lines from before a restart stay
      if (pids.current.size !== before) render(true);
    } catch { /* invalid package while typing */ }
  };

  const stop = () => {
    source.current?.close();
    source.current = null;
    setRunning(false);
  };

  const start = () => {
    if (!ready) return fail(new Error('Select a device first'));
    stop();
    buffer.current = [];
    pids.current = new Set();
    refreshPids().then(() => render(true));
    const es = apiEvents(`/api/logcat?serial=${encodeURIComponent(serial)}&tail=500`);
    es.onmessage = (e: MessageEvent) => {
      const added = (JSON.parse(e.data) as string[]).map(parse);
      buffer.current.push(...added);
      if (buffer.current.length > MAX_BUFFER) buffer.current.splice(0, buffer.current.length - MAX_BUFFER);
      if (!pausedRef.current) render(false, added);
    };
    es.addEventListener('end', () => { stop(); toast('Logcat ended'); });
    es.onerror = () => { if (es.readyState === 2) stop(); };
    source.current = es;
    setRunning(true);
  };

  useEffect(() => stop, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { stop(); }, [serial]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!running || !pkg) return;
    const t = setInterval(refreshPids, 2000);
    return () => clearInterval(t);
  }, [running, pkg]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(() => render(true), 150);
    return () => clearTimeout(t);
  }, [level, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { pids.current = new Set(); refreshPids().then(() => render(true)); }, [pkg]); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    showPackage: (p: string) => {
      setPkg(p);
      filterRef.current.pkg = p;
      if (!source.current) start();
    },
  }));

  const clear = () => {
    buffer.current = [];
    render(true);
    if (serial) api('/api/logcat/clear', { body: { serial } }).catch(fail);
  };
  const save = () => {
    const f = makeFilter();
    const url = URL.createObjectURL(new Blob([buffer.current.filter(f.test).map((l) => l.raw).join('\n')], { type: 'text/plain' }));
    downloadUrl(url, `logcat-${stamp()}.txt`);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <>
      <div className="toolbar">
        <Button variant={running ? 'danger-soft' : 'primary'} icon={running ? Square : Play} onClick={running ? stop : start} disabled={!ready && !running}>{running ? 'Stop' : 'Start'}</Button>
        <Button icon={paused ? Play : Pause} active={paused} disabled={!running} onClick={() => {
          pausedRef.current = !paused;
          setPaused(!paused);
          if (paused) render(true);
        }}>{paused ? 'Resume' : 'Pause'}</Button>
        <Button icon={Eraser} onClick={clear} title="Clear the phone's log buffer and this view">Clear</Button>
        <Button icon={Save} onClick={save} title="Save the filtered lines">Save</Button>
        <span className="spacer" />
        <span className="muted small">{count}</span>
      </div>
      <div className="toolbar">
        <div className="field" style={{ flex: '1 1 220px' }}><Package /><input className="input mono" list="dp-pkgs" placeholder="Filter by app package" value={pkg} onChange={(e) => setPkg(e.target.value.trim())} /></div>
        <datalist id="dp-pkgs">{apps.map((p) => <option key={p} value={p} />)}</datalist>
        <select className="select" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Minimum level">
          <option value="V">Verbose</option><option value="D">Debug</option><option value="I">Info</option><option value="W">Warning</option><option value="E">Error</option>
        </select>
        <div className="field" style={{ flex: '2 1 240px' }}><Search /><input className="input" type="search" placeholder="Search or regex" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      </div>
      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* children are managed imperatively — keep React content out of the <pre> */}
        <pre className="console logview scroll-thin" ref={view} />
        {!running && !count && <span className="muted" style={{ position: 'absolute', top: 12, left: 14 }}>Press Start to stream the phone's log.</span>}
      </div>
    </>
  );
}
