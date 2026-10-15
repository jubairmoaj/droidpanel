import { useEffect, useState } from 'react';
import { Battery, Clock, Cpu, HardDrive, Link2, Monitor, Plus, Smartphone, SlidersHorizontal, Wifi, X, Bot } from 'lucide-react';
import { WEB, api, useDevices } from '../state';
import { Button, Empty, SectionHead, Switch, useBusy, useToast } from '../ui';

type Info = {
  manufacturer: string; model: string; android: string; sdk: string; abi: string; build: string; screen: string; density: string;
  battery: { level: number; charging: boolean; temp: number | null }; ip: string | null;
  storage: { size: string; used: string; free: string; pct: string } | null; uptimeSec: number;
};
type Toggle = { name: string; label: string; on: boolean };

export function Overview({ active }: { active: boolean }) {
  const { serial, ready, device } = useDevices();
  const { fail } = useToast();
  const [info, setInfo] = useState<Info | null>(null);
  const [toggles, setToggles] = useState<Toggle[]>([]);
  const [pending, setPending] = useState('');

  useEffect(() => {
    setInfo(null);
    setToggles([]);
    if (!active || !ready) return;
    const q = encodeURIComponent(serial);
    api(`/api/info?serial=${q}`).then(setInfo, fail);
    api(`/api/toggles?serial=${q}`).then(setToggles, fail);
  }, [active, ready, serial, fail]);

  if (!ready) {
    return <Empty icon={Smartphone} title={device ? `${device.model || device.serial} is ${device.state}` : 'No device connected'}>
      {device?.state === 'unauthorized' ? 'Unlock the phone and tap "Allow" on the USB debugging prompt.' : 'Plug in your phone with USB debugging on, then use Connect device.'}
    </Empty>;
  }

  const flip = async (t: Toggle) => {
    setPending(t.name);
    setToggles((l) => l.map((x) => (x.name === t.name ? { ...x, on: !t.on } : x)));
    try {
      await api('/api/toggles', { body: { serial, name: t.name, on: !t.on } });
    } catch (e) {
      setToggles((l) => l.map((x) => (x.name === t.name ? { ...x, on: t.on } : x)));
      fail(e);
    } finally { setPending(''); }
  };

  const used = info?.storage ? parseInt(info.storage.pct, 10) : NaN;
  const up = info ? `${Math.floor(info.uptimeSec / 86400) ? `${Math.floor(info.uptimeSec / 86400)}d ` : ''}${Math.floor((info.uptimeSec % 86400) / 3600)}h ${Math.floor((info.uptimeSec % 3600) / 60)}m` : '';

  return (
    <>
      <section>
        <SectionHead icon={Smartphone} title="Device" />
        <div className="stats">
          <Stat icon={Smartphone} k="Model" v={info ? `${info.manufacturer} ${info.model}` : '…'} />
          <Stat icon={Bot} k="Android" v={info ? `${info.android} · API ${info.sdk}` : '…'} />
          <Stat icon={Battery} k="Battery" v={info ? (Number.isFinite(info.battery.level) ? `${info.battery.level}%${info.battery.charging ? ' · charging' : ''}${info.battery.temp ? ` · ${info.battery.temp}°C` : ''}` : '—') : '…'}
            meter={info?.battery.level} />
          <Stat icon={HardDrive} k="Storage" v={info ? (info.storage ? `${info.storage.free} free of ${info.storage.size}` : '—') : '…'} meter={Number.isFinite(used) ? used : undefined} />
          <Stat icon={Monitor} k="Screen" v={info ? `${info.screen} · ${info.density} dpi` : '…'} />
          <Stat icon={Wifi} k="Wi-Fi IP" v={info ? info.ip ?? '—' : '…'} />
          <Stat icon={Cpu} k="CPU ABI" v={info?.abi ?? '…'} />
          <Stat icon={Clock} k="Uptime" v={info ? up : '…'} />
        </div>
      </section>
      <section>
        <SectionHead icon={SlidersHorizontal} title="Developer toggles">Applied instantly on the phone</SectionHead>
        <div className="toggles">
          {toggles.map((t) => (
            <div key={t.name} className="toggle" onClick={() => pending !== t.name && flip(t)}>
              <span>{t.label}</span>
              <Switch checked={t.on} disabled={pending === t.name} label={t.label} onChange={() => flip(t)} />
            </div>
          ))}
          {!toggles.length && <span className="muted small">Loading…</span>}
        </div>
      </section>
      {!WEB && <Reverse serial={serial} />}
    </>
  );
}

function Stat({ icon: Icon, k, v, meter }: { icon: typeof Smartphone; k: string; v: string; meter?: number }) {
  return (
    <div className="stat">
      <div className="ico"><Icon /></div>
      <div className="grow">
        <div className="k">{k}</div>
        <div className="v">{v}</div>
        {meter !== undefined && Number.isFinite(meter) && <div className="meter"><i style={{ width: `${Math.max(0, Math.min(100, meter))}%` }} /></div>}
      </div>
    </div>
  );
}

function Reverse({ serial }: { serial: string }) {
  const [list, setList] = useState<{ remote: string; local: string }[]>([]);
  const [remote, setRemote] = useState('');
  const [local, setLocal] = useState('');
  const { busy, run } = useBusy();
  const load = () => api(`/api/reverse?serial=${encodeURIComponent(serial)}`).then(setList, () => setList([]));
  useEffect(() => { load(); }, [serial]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section>
      <SectionHead icon={Link2} title="Port reverse">The phone's localhost:PORT reaches this PC</SectionHead>
      <form className="toolbar" onSubmit={(e) => {
        e.preventDefault();
        run('add', async () => {
          const r = await api('/api/reverse', { body: { serial, remote, local: local || remote } });
          if (!r.ok) throw new Error(r.output);
          setRemote(''); setLocal('');
          load();
        });
      }}>
        <input className="input" inputMode="numeric" placeholder="Phone port, e.g. 4000" value={remote} onChange={(e) => setRemote(e.target.value)} required />
        <input className="input" inputMode="numeric" placeholder="PC port (same)" value={local} onChange={(e) => setLocal(e.target.value)} />
        <Button type="submit" icon={Plus} loading={busy === 'add'}>Add</Button>
      </form>
      <div className="chips" style={{ marginTop: 10 }}>
        {list.map((r) => (
          <span key={r.remote} className="chip mono">{r.remote} → {r.local}
            <Button size="sm" variant="ghost" icon={X} title="Remove" onClick={() => run(r.remote, async () => { await api('/api/reverse', { body: { serial, remove: r.remote } }); load(); })} />
          </span>
        ))}
        {!list.length && <span className="muted small">None yet. Tip: reverse 4000 so the app can call http://localhost:4000 on this PC.</span>}
      </div>
    </section>
  );
}
