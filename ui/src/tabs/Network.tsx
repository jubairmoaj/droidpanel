import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { CircleHelp, Copy, Eraser, Globe, Play, Search, Square, Terminal, X } from 'lucide-react';
import { apiEvents } from '../core/api.js';
import { useDevices } from '../state';
import { Badge, Button, Empty, useToast } from '../ui';

type Req = {
  id: string; method?: string; url?: string; status?: number | null; durationMs?: number; startedAt?: number; done?: boolean;
  reqHeaders?: Record<string, string>; resHeaders?: Record<string, string> | null; reqBody?: string | null; resBody?: string | null; error?: string | null;
};
const MAX = 2000;
const cat = (it: Req) => (!it.done ? 'pending' : it.status ? String(it.status)[0] : 'err');
const fmtSize = (n?: number | null) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtMs = (n?: number) => (n == null ? '' : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(2)} s`);
const pretty = (b?: string | null) => { if (!b) return ''; try { return JSON.stringify(JSON.parse(b), null, 2); } catch { return b; } };
const parts = (u?: string) => { try { const x = new URL(u!); return { host: x.host, path: x.pathname + x.search }; } catch { return { host: '', path: u ?? '' }; } };

export function Network({ active, onCount }: { active: boolean; onCount: (n: number) => void }) {
  const { serial, ready } = useDevices();
  const { toast, fail } = useToast();
  const items = useRef(new Map<string, Req>());
  const order = useRef<string[]>([]);
  const source = useRef<{ close: () => void } | null>(null);
  const [version, setVersion] = useState(0);
  const [running, setRunning] = useState(false);
  const [q, setQ] = useState('');
  const [st, setSt] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const queued = useRef(false);

  const bump = () => {
    if (queued.current) return;
    queued.current = true;
    setTimeout(() => { queued.current = false; setVersion((v) => v + 1); }, 150);
  };
  const stop = () => { source.current?.close(); source.current = null; setRunning(false); };
  const start = () => {
    if (!ready) return fail(new Error('Select a device first'));
    stop();
    const es = apiEvents(`/api/net?serial=${encodeURIComponent(serial)}`);
    es.onmessage = (e: MessageEvent) => {
      for (const { phase, ...ev } of JSON.parse(e.data) as (Req & { phase: string })[]) {
        let it = items.current.get(ev.id);
        if (!it) { it = { id: ev.id }; items.current.set(ev.id, it); order.current.push(ev.id); }
        Object.assign(it, ev);
        if (phase === 'end') it.done = true;
      }
      while (order.current.length > MAX) items.current.delete(order.current.shift()!);
      bump();
    };
    es.addEventListener('end', () => { stop(); toast('Network capture ended'); });
    es.onerror = () => { if (es.readyState === 2) stop(); };
    source.current = es;
    setRunning(true);
  };
  useEffect(() => { if (active && ready && !source.current) start(); }, [active, ready, serial]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { stop(); }, [serial]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => stop, []); // eslint-disable-line react-hooks/exhaustive-deps

  const all = useMemo(() => order.current.map((id) => items.current.get(id)!), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => all.filter((it) => (!q || (it.url ?? '').toLowerCase().includes(q.toLowerCase())) && (!st || cat(it) === st)), [all, q, st]);
  const failed = all.filter((it) => ['4', '5', 'err'].includes(cat(it))).length;
  useEffect(() => onCount(all.length), [all.length, onCount]);
  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 60) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const clear = () => { items.current.clear(); order.current = []; setSel(null); setVersion((v) => v + 1); };
  const it = sel ? items.current.get(sel) : undefined;

  return (
    <>
      <div className="toolbar">
        <Button variant={running ? 'danger-soft' : 'primary'} icon={running ? Square : Play} onClick={running ? stop : start} disabled={!ready && !running}>{running ? 'Stop' : 'Capture'}</Button>
        <Button icon={Eraser} onClick={clear}>Clear</Button>
        <div className="field" style={{ flex: '1 1 220px' }}><Search /><input className="input" type="search" placeholder="Filter by URL, e.g. /products" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select className="select" value={st} onChange={(e) => setSt(e.target.value)} aria-label="Status">
          <option value="">All statuses</option><option value="2">2xx</option><option value="3">3xx</option><option value="4">4xx</option>
          <option value="5">5xx</option><option value="err">Failed</option><option value="pending">Pending</option>
        </select>
        <Button variant="ghost" icon={CircleHelp} active={help} onClick={() => setHelp(!help)}>Setup</Button>
      </div>
      {help && (
        <div className="panel panel-pad stack" style={{ gap: 8 }}>
          <span>Your app writes each request to logcat with a tiny debug-only logger, and droidpanel shows it here. Works with HTTPS; no proxy or certificates.</span>
          <span><b>Flutter (Dio):</b> copy <a href="/snippets/droidpanel_net.dart" target="_blank">droidpanel_net.dart</a> into your app, then:</span>
          <pre className="console">{"import 'package:flutter/foundation.dart';\n\nif (kDebugMode) dio.interceptors.add(DroidpanelNetLog());"}</pre>
          <span><b>Native Android (OkHttp / Retrofit):</b> copy <a href="/snippets/DroidpanelNet.kt" target="_blank">DroidpanelNet.kt</a>, then:</span>
          <pre className="console">{'OkHttpClient.Builder()\n    .apply { if (BuildConfig.DEBUG) addNetworkInterceptor(droidpanel.DroidpanelNet()) }\n    .build()'}</pre>
          <span className="muted small">Authorization and cookie headers are masked. Bodies over 64 KB are truncated.</span>
        </div>
      )}
      <div className={`net${it ? ' open' : ''}`}>
        <div className="net-table scroll-thin" ref={listRef}>
          <div className="net-row head"><span>Status</span><span>Method</span><span>URL</span><span className="num">Size</span><span className="num">Time</span></div>
          {shown.map((r) => {
            const c = cat(r);
            const { host, path } = parts(r.url);
            return (
              <div key={r.id} className={`net-row${r.id === sel ? ' on' : ''}`} onClick={() => setSel(r.id)} title={r.url}>
                <span className={`st st-${c}`}>{c === 'pending' ? '…' : c === 'err' ? 'ERR' : r.status}</span>
                <span className={`m m-${r.method}`}>{r.method}</span>
                <span className="truncate"><span className="host">{host}</span>{path}</span>
                <span className="num">{fmtSize(r.resBody?.length)}</span>
                <span className="num">{fmtMs(r.durationMs)}</span>
              </div>
            );
          })}
          {!shown.length && (
            <Empty icon={Globe} title={all.length ? 'No requests match' : running ? 'Listening…' : 'Not capturing'}>
              {all.length ? 'Change the filter.' : 'Use your app. Nothing showing? Open Setup: the app needs the small logger.'}
            </Empty>
          )}
        </div>
        {it && <Detail it={it} onClose={() => setSel(null)} />}
      </div>
      {all.length > 0 && <span className="muted small">{shown.length} shown · {all.length} captured · {failed} failed</span>}
    </>
  );
}

function Detail({ it, onClose }: { it: Req; onClose: () => void }) {
  const { toast, fail } = useToast();
  const c = cat(it);
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast('Copied'), fail);
  const curl = () => {
    const sq = (x: string) => `'${String(x).replace(/'/g, `'\\''`)}'`;
    const p = [`curl -X ${it.method} ${sq(it.url ?? '')}`];
    for (const [k, v] of Object.entries(it.reqHeaders ?? {})) p.push(`-H ${sq(`${k}: ${v}`)}`);
    if (it.reqBody) p.push(`--data-raw ${sq(it.reqBody)}`);
    return p.join(' \\\n  ');
  };
  const kv = (h?: Record<string, string> | null) => (h && Object.keys(h).length
    ? <dl className="kv">{Object.entries(h).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
    : <p className="muted small">None</p>);
  return (
    <div className="net-detail scroll-thin">
      <div className="toolbar">
        <Badge tone={c === '2' ? 'success' : c === '4' ? 'warning' : c === '5' || c === 'err' ? 'danger' : c === 'pending' ? undefined : 'info'}>
          {c === 'pending' ? 'Pending' : c === 'err' ? 'Failed' : it.status}
        </Badge>
        <span className={`m m-${it.method}`}>{it.method}</span>
        <span className="muted small">{fmtMs(it.durationMs)}{it.resBody != null ? ` · ${fmtSize(it.resBody.length)}` : ''}{it.startedAt ? ` · ${new Date(it.startedAt).toLocaleTimeString()}` : ''}</span>
        <span className="spacer" />
        <Button variant="ghost" icon={X} onClick={onClose} title="Close" />
      </div>
      <div className="url">{it.url}</div>
      <div className="btn-group">
        <Button size="sm" icon={Copy} onClick={() => copy(it.url ?? '')}>URL</Button>
        <Button size="sm" icon={Terminal} onClick={() => copy(curl())}>cURL</Button>
        <Button size="sm" icon={Copy} disabled={!it.resBody} onClick={() => copy(pretty(it.resBody))}>Response</Button>
      </div>
      {it.error && <><h5>Error</h5><pre className="console">{it.error}</pre></>}
      <h5>Response body</h5>{it.resBody ? <pre className="console">{pretty(it.resBody)}</pre> : <p className="muted small">{it.done ? 'Empty' : 'Waiting…'}</p>}
      {it.reqBody && <><h5>Request body</h5><pre className="console">{pretty(it.reqBody)}</pre></>}
      <h5>Request headers</h5>{kv(it.reqHeaders)}
      <h5>Response headers</h5>{kv(it.resHeaders)}
    </div>
  );
}
