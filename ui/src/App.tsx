import { useCallback, useEffect, useRef, useState } from 'react';
import { Gauge, Globe, Hammer, Laptop, Moon, Package, Plus, ScrollText, Sun, Wrench } from 'lucide-react';
import { DevicePane } from './DevicePane';
import { ConnectDialog } from './ConnectDialog';
import { BuildProvider, DeviceProvider, WEB, api, useAgentConnected, useDevices, type Device } from './state';
import { Button, ToastProvider, store } from './ui';
import { Overview } from './tabs/Overview';
import { Apps } from './tabs/Apps';
import { Logcat, type LogcatHandle } from './tabs/Logcat';
import { Network } from './tabs/Network';
import { Build } from './tabs/Build';
import { Tools } from './tabs/Tools';

const TABS = [
  { id: 'overview', label: 'Overview', icon: Gauge },
  { id: 'apps', label: 'Apps', icon: Package },
  { id: 'logcat', label: 'Logcat', icon: ScrollText },
  { id: 'network', label: 'Network', icon: Globe },
  { id: 'build', label: 'Build & Run', icon: Hammer },
  { id: 'tools', label: 'Tools', icon: Wrench },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function App() {
  return (
    <ToastProvider>
      <DeviceProvider>
        <BuildProvider>
          <Shell />
        </BuildProvider>
      </DeviceProvider>
    </ToastProvider>
  );
}

function Shell() {
  const [tab, setTabState] = useState<TabId>(() => (TABS.some((t) => t.id === store.get('tab')) ? store.get('tab') as TabId : 'overview'));
  const [connectOpen, setConnectOpen] = useState(false);
  const [netCount, setNetCount] = useState(0);
  const [apps, setApps] = useState<string[]>([]);
  const logcat = useRef<LogcatHandle>(null);
  const { serial, ready } = useDevices();
  const setTab = (t: TabId) => { setTabState(t); store.set('tab', t); };

  // Package names for the logcat / deep-link pickers.
  useEffect(() => {
    if (!ready) return setApps([]);
    api(`/api/apps?serial=${encodeURIComponent(serial)}&all=0`).then(setApps, () => setApps([]));
  }, [serial, ready]);

  const showLogcat = useCallback((pkg: string) => { setTab('logcat'); logcat.current?.showPackage(pkg); }, []);

  return (
    <>
      <TopBar onConnect={() => setConnectOpen(true)} onHelper={() => setTab('build')} />
      <main className="shell">
        <DevicePane />
        <section className="card workspace">
          <nav className="tabs scroll-thin" role="tablist">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button key={id} role="tab" aria-selected={tab === id} className={`tab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>
                <Icon />{label}{id === 'network' && netCount > 0 && <span className="count">{netCount}</span>}
              </button>
            ))}
          </nav>
          {/* Tabs stay mounted so running streams (logcat, network) survive switching. */}
          <div className="tab-body" hidden={tab !== 'overview'}><Overview active={tab === 'overview'} /></div>
          <div className="tab-body" hidden={tab !== 'apps'}><Apps active={tab === 'apps'} onLogcat={showLogcat} /></div>
          <div className="tab-body" hidden={tab !== 'logcat'}><Logcat ref={logcat} apps={apps} /></div>
          <div className="tab-body" hidden={tab !== 'network'}><Network active={tab === 'network'} onCount={setNetCount} /></div>
          <div className="tab-body" hidden={tab !== 'build'}><Build active={tab === 'build'} /></div>
          <div className="tab-body" hidden={tab !== 'tools'}><Tools active={tab === 'tools'} apps={apps} /></div>
        </section>
      </main>
      <ConnectDialog open={connectOpen} onClose={() => setConnectOpen(false)} />
    </>
  );
}

const label = (d: Device) => `${d.model || d.serial} · ${d.transport === 'wifi' ? 'Wi-Fi' : 'USB'}${d.state === 'device' ? '' : ` — ${d.state}`}`;

function TopBar({ onConnect, onHelper }: { onConnect: () => void; onHelper: () => void }) {
  const { devices, serial, device, select, adbOk, hint } = useDevices();
  const helper = useAgentConnected();
  const [theme, setTheme] = useState(store.get('theme'));
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
  }, [theme]);
  const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const flip = () => { const t = dark ? 'light' : 'dark'; setTheme(t); store.set('theme', t); };
  const dot = device?.state === 'device' ? 'on' : device ? 'warn' : '';

  return (
    <header className="topbar">
      <div className="brand">
        <img src="/icon.svg" alt="" />droidpanel
        {WEB && <span className="mode hide-sm">hosted</span>}
      </div>
      <span className="sep hide-sm" />
      <div className="device-picker">
        <span className={`dot ${dot}`} />
        <select className="select" value={serial} onChange={(e) => select(e.target.value)} aria-label="Device">
          {!adbOk ? <option value="">{hint ?? 'adb not found — install Android platform-tools'}</option>
            : devices.length ? devices.map((d) => <option key={d.serial} value={d.serial} disabled={d.state !== 'device'}>{label(d)}</option>)
              : <option value="">No device — connect one</option>}
        </select>
      </div>
      <div className="actions">
        {WEB && (
          <button type="button" className="helper-pill hide-sm" onClick={onHelper} title="PC helper for Build & Run">
            <span className={`dot ${helper ? 'on' : ''}`} /><Laptop size={14} />{helper ? 'PC helper connected' : 'PC helper off'}
          </button>
        )}
        <Button variant="primary" icon={Plus} onClick={onConnect}>Connect device</Button>
        <Button variant="ghost" icon={dark ? Sun : Moon} onClick={flip} title="Toggle theme" aria-label="Toggle theme" />
      </div>
    </header>
  );
}
