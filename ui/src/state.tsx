// App-wide state: connected devices, the selected device, and Build & Run (projects/jobs).
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { WEB, agent, api, backend } from './core/api.js';
import { store, useToast } from './ui';

export type Device = { serial: string; state: string; model: string; product: string; transport: 'usb' | 'wifi'; error?: string | null };
export type Project = {
  id: string; name: string; type: 'flutter' | 'android' | 'react-native'; root: string; packageId: string; buildArgs: string;
  autoReload: boolean; running: boolean;
  job: { id: string; task: string; step: string | null } | null;
  session: { id: string; ready: boolean; reloads: number } | null;
};
export type JobSummary = { id: string; projectId: string; project: string; task: string; status: string; step: string | null; interactive: boolean };

type DeviceState = {
  devices: Device[]; serial: string; device: Device | null; ready: boolean;
  adbOk: boolean; hint: string | null; scrcpy: { available: boolean; version: string | null };
  select: (serial: string) => void; refresh: () => Promise<void>;
};
const DeviceCtx = createContext<DeviceState>(null!);
export const useDevices = () => useContext(DeviceCtx);

export function DeviceProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const [devices, setDevices] = useState<Device[]>([]);
  const [serial, setSerial] = useState(store.get('serial'));
  const [meta, setMeta] = useState({ adbOk: true, hint: null as string | null, scrcpy: { available: false, version: null as string | null } });
  const sig = useRef('');
  const serialRef = useRef(serial);
  serialRef.current = serial;

  const select = useCallback((s: string) => {
    setSerial(s);
    store.set('serial', s);
  }, []);

  const refresh = useCallback(async () => {
    let data;
    try { data = await api('/api/devices'); } catch { return; }
    setMeta({ adbOk: data.adb !== false, hint: data.hint ?? null, scrcpy: data.scrcpy ?? { available: false, version: null } });
    const list: Device[] = data.devices ?? [];
    const s = JSON.stringify(list);
    if (s === sig.current) return;
    const before = sig.current ? (JSON.parse(sig.current) as Device[]) : [];
    sig.current = s;
    setDevices(list);
    for (const d of list) {
      const prev = before.find((b) => b.serial === d.serial);
      if (d.state === 'unauthorized' && prev?.state !== 'unauthorized') toast(`${d.model || d.serial}: tap "Allow" on the phone's USB debugging prompt`);
      if (d.error && d.error !== prev?.error) toast(`${d.model || d.serial}: ${d.error}`, true);
    }
    const ready = list.filter((d) => d.state === 'device');
    if (!ready.some((d) => d.serial === serialRef.current)) select(ready[0]?.serial ?? '');
  }, [select, toast]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    backend?.onChange(() => refresh());
    return () => clearInterval(t);
  }, [refresh]);

  const device = devices.find((d) => d.serial === serial) ?? null;
  return (
    <DeviceCtx.Provider value={{ devices, serial, device, ready: device?.state === 'device', ...meta, select, refresh }}>
      {children}
    </DeviceCtx.Provider>
  );
}

// ── Build & Run ─────────────────────────────────────────────────────────────

type BuildState = {
  /** Local server: always. Hosted: only while the PC helper is connected. */
  available: boolean;
  projects: Project[]; jobs: JobSummary[];
  currentJob: string; follow: (id: string) => void;
  quickId: string; setQuickId: (id: string) => void;
  refresh: () => Promise<void>;
};
const BuildCtx = createContext<BuildState>(null!);
export const useBuild = () => useContext(BuildCtx);

/** Whether the hosted page is connected to the PC helper. Always true for the local server. */
export function useAgentConnected() {
  const [on, setOn] = useState(agent ? agent.connected : true);
  useEffect(() => { agent?.onChange(setOn); }, []);
  return on;
}

export function BuildProvider({ children }: { children: ReactNode }) {
  const available = useAgentConnected();
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [currentJob, setCurrentJob] = useState(store.get('job'));
  const [quickId, setQuick] = useState(store.get('quickProject'));

  const refresh = useCallback(async () => {
    if (!available) return;
    try {
      const d = await api('/api/projects');
      setProjects(d.projects);
      setJobs(d.jobs);
    } catch { /* server restarting / helper gone */ }
  }, [available]);

  useEffect(() => {
    if (!available) { setProjects([]); setJobs([]); return; }
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [available, refresh]);

  const follow = useCallback((id: string) => { setCurrentJob(id); store.set('job', id); }, []);
  const setQuickId = useCallback((id: string) => { setQuick(id); store.set('quickProject', id); }, []);
  const effectiveQuick = projects.some((p) => p.id === quickId) ? quickId : projects[0]?.id ?? '';

  return (
    <BuildCtx.Provider value={{ available, projects, jobs, currentJob, follow, quickId: effectiveQuick, setQuickId, refresh }}>
      {children}
    </BuildCtx.Provider>
  );
}

export { WEB, agent, api, backend };
