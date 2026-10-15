import { useEffect, useMemo, useState } from 'react';
import { Download, Eraser, Info, Package, Play, RotateCcw, ScrollText, Search, Square, Trash2, RefreshCw, Upload } from 'lucide-react';
import { WEB, api, apiFetch } from '../core/api.js';
import { useDevices } from '../state';
import { Badge, Button, Empty, downloadUrl, pkgColor, pkgInitial, store, useBusy, useToast } from '../ui';

type Details = { pkg: string; versionName: string | null; versionCode: string | null; targetSdk: string | null; firstInstall: string | null; lastUpdate: string | null; pids: string[] };

export function Apps({ active, onLogcat }: { active: boolean; onLogcat: (pkg: string) => void }) {
  const { serial, ready } = useDevices();
  const { toast, fail } = useToast();
  const [apps, setApps] = useState<string[]>([]);
  const [all, setAll] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(store.get('app'));
  const [loading, setLoading] = useState(false);

  const load = () => {
    if (!ready) return setApps([]);
    setLoading(true);
    api(`/api/apps?serial=${encodeURIComponent(serial)}&all=${all ? 1 : 0}`).then(setApps, fail).finally(() => setLoading(false));
  };
  useEffect(() => { if (active) load(); }, [active, serial, ready, all]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => (q ? apps.filter((p) => p.toLowerCase().includes(q.toLowerCase())) : apps), [apps, q]);
  const pick = (p: string) => { setSel(p); store.set('app', p); };

  const install = async (file: File) => {
    if (!file.name.endsWith('.apk')) return fail(new Error('That is not an .apk file'));
    toast(`Installing ${file.name}…`);
    try {
      const r = await api(`/api/install?serial=${encodeURIComponent(serial)}`, { body: file, raw: true, headers: { 'content-type': 'application/octet-stream' } });
      if (!r.ok) throw new Error(r.output);
      toast(`Installed ${file.name}`);
      load();
    } catch (e) { fail(e); }
  };

  if (!ready) return <Empty icon={Package} title="No device connected">Connect a phone to see its apps.</Empty>;

  return (
    <>
      <DropZone accept=".apk" icon={Upload} onFile={install}>Drop an <b>.apk</b> here to install it, or</DropZone>
      <div className="apps">
        <div className="stack" style={{ gap: 8, minWidth: 0 }}>
          <div className="toolbar">
            <div className="field grow"><Search /><input className="input" type="search" placeholder="Search packages" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <Button variant="ghost" icon={RefreshCw} loading={loading} onClick={load} title="Refresh" />
          </div>
          <div className="toolbar">
            <label className="check small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Include system apps</label>
            <span className="spacer" />
            <span className="muted small">{shown.length} of {apps.length}</span>
          </div>
          <div className="list scroll-thin">
            {shown.map((p) => (
              <div key={p} className={`list-item${p === sel ? ' on' : ''}`} onClick={() => pick(p)}>
                <span className="app-ico" style={{ background: pkgColor(p) }}>{pkgInitial(p)}</span>
                <span className="truncate">{p}</span>
              </div>
            ))}
            {!shown.length && <div className="empty small">{loading ? 'Loading…' : 'No packages'}</div>}
          </div>
        </div>
        {sel && apps.includes(sel) ? <AppDetail key={sel} pkg={sel} onLogcat={onLogcat} onRemoved={() => { setSel(''); load(); }} />
          : <div className="panel"><Empty icon={Package} title="Select an app">Pick a package to launch, stop, clear, uninstall or download its APK.</Empty></div>}
      </div>
    </>
  );
}

function AppDetail({ pkg, onLogcat, onRemoved }: { pkg: string; onLogcat: (pkg: string) => void; onRemoved: () => void }) {
  const { serial } = useDevices();
  const { toast, fail } = useToast();
  const { busy, run } = useBusy();
  const [d, setD] = useState<Details | null>(null);
  const load = () => api(`/api/app?serial=${encodeURIComponent(serial)}&pkg=${encodeURIComponent(pkg)}`).then(setD, fail);
  useEffect(() => { load(); }, [pkg, serial]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = (action: string) => run(action, async () => {
    if (action === 'apk') {
      const url = `/api/app/apk?serial=${encodeURIComponent(serial)}&pkg=${encodeURIComponent(pkg)}`;
      if (!WEB) return downloadUrl(url, `${pkg}.apk`);
      toast('Downloading APK from the phone…');
      const r = await apiFetch(url);
      if (!r.ok) throw new Error((await r.json()).error);
      const blobUrl = URL.createObjectURL(await r.blob());
      downloadUrl(blobUrl, `${pkg}.apk`);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      return;
    }
    if ((action === 'clear' || action === 'uninstall') && !confirm(`${action === 'clear' ? 'Clear all data of' : 'Uninstall'} ${pkg}?`)) return;
    const r = await api('/api/app', { body: { serial, pkg, action } });
    if (!r.ok) throw new Error(r.output || 'Failed');
    toast(`${pkg}: ${action} done`);
    if (action === 'uninstall') onRemoved(); else setTimeout(load, 600);
  });

  const running = (d?.pids.length ?? 0) > 0;
  return (
    <div className="panel panel-pad" style={{ alignSelf: 'start' }}>
      <div className="detail-head">
        <span className="app-ico" style={{ background: pkgColor(pkg) }}>{pkgInitial(pkg)}</span>
        <div className="grow">
          <h4>{pkg}</h4>
          {d && <Badge tone={running ? 'success' : undefined}>{running ? `running · pid ${d.pids.join(', ')}` : 'not running'}</Badge>}
        </div>
      </div>
      <dl className="kv">
        <dt>Version</dt><dd>{d ? `${d.versionName ?? '—'} (${d.versionCode ?? '—'})` : '…'}</dd>
        <dt>Target SDK</dt><dd>{d?.targetSdk ?? '—'}</dd>
        <dt>Installed</dt><dd>{d?.firstInstall ?? '—'}</dd>
        <dt>Updated</dt><dd>{d?.lastUpdate ?? '—'}</dd>
      </dl>
      <div className="stack" style={{ gap: 10 }}>
        <div className="btn-group">
          <Button variant="primary" icon={Play} loading={busy === 'launch'} onClick={() => act('launch')}>Launch</Button>
          <Button icon={RotateCcw} loading={busy === 'restart'} onClick={() => act('restart')}>Restart</Button>
          <Button icon={Square} loading={busy === 'stop'} onClick={() => act('stop')}>Force stop</Button>
          <Button icon={ScrollText} onClick={() => onLogcat(pkg)}>Logcat</Button>
        </div>
        <div className="btn-group">
          <Button icon={Info} loading={busy === 'info'} onClick={() => act('info')}>App info</Button>
          <Button icon={Download} loading={busy === 'apk'} onClick={() => act('apk')}>Download APK</Button>
          <Button variant="danger-soft" icon={Eraser} loading={busy === 'clear'} onClick={() => act('clear')}>Clear data</Button>
          <Button variant="danger-soft" icon={Trash2} loading={busy === 'uninstall'} onClick={() => act('uninstall')}>Uninstall</Button>
        </div>
      </div>
    </div>
  );
}

export function DropZone({ accept, icon: Icon, onFile, children }: { accept?: string; icon: typeof Upload; onFile: (f: File) => void; children: React.ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <div className={`dropzone${over ? ' over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); [...e.dataTransfer.files].forEach(onFile); }}>
      <Icon />
      <span>{children} <label>browse<input type="file" accept={accept} hidden onChange={(e) => { [...(e.target.files ?? [])].forEach(onFile); e.target.value = ''; }} /></label></span>
    </div>
  );
}
