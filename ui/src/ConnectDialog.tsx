import { useEffect, useRef, useState } from 'react';
import { Info, KeyRound, Link2, QrCode, RefreshCw, Usb, Wifi, X } from 'lucide-react';
import { WEB, api, backend, useDevices } from './state';
import { Button, store, useBusy, useToast } from './ui';

type Tab = 'usb' | 'qr' | 'code' | 'ip';

export function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>(WEB ? 'usb' : (store.get('ctab', 'usb') as Tab));
  const [out, setOut] = useState('');
  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const pick = (t: Tab) => { setTab(t); store.set('ctab', t); setOut(''); };

  return (
    <dialog ref={ref} className="modal" onClose={onClose}>
      <div className="modal-head">
        <h2>Connect a device</h2>
        <Button variant="ghost" icon={X} onClick={onClose} aria-label="Close" />
      </div>
      {!WEB && (
        <div className="tabs" style={{ padding: '0 12px' }}>
          {([['usb', 'USB', Usb], ['qr', 'QR code', QrCode], ['code', 'Pairing code', KeyRound], ['ip', 'IP address', Link2]] as const).map(([k, label, Icon]) => (
            <button key={k} type="button" className={`tab${tab === k ? ' on' : ''}`} onClick={() => pick(k)}><Icon />{label}</button>
          ))}
        </div>
      )}
      <div className="modal-body">
        {open && tab === 'usb' && <UsbPanel onDone={onClose} setOut={setOut} />}
        {open && tab === 'qr' && <QrPanel />}
        {open && tab === 'code' && <CodePanel setOut={setOut} />}
        {open && tab === 'ip' && <IpPanel setOut={setOut} />}
        {out && <pre className="console" style={{ maxHeight: 180 }}>{out}</pre>}
      </div>
    </dialog>
  );
}

function UsbPanel({ onDone, setOut }: { onDone: () => void; setOut: (s: string) => void }) {
  const { refresh, select, devices, serial } = useDevices();
  const { toast } = useToast();
  const { busy, run } = useBusy();
  return (
    <>
      <ol>
        <li>On the phone: <b>Settings → About phone</b>, tap <b>Build number</b> 7 times.</li>
        <li>Open <b>Developer options</b> and turn on <b>USB debugging</b>.</li>
        <li>Plug in the cable and tap <b>Allow</b> on the phone (tick <i>Always allow</i>).</li>
      </ol>
      {WEB ? (
        <>
          <Button variant="primary" size="lg" icon={Usb} loading={busy === 'pick'} onClick={() => run('pick', async () => {
            setOut('');
            let s: string;
            try { s = await backend!.requestDevice(); } catch (e) {
              if ((e as Error).name === 'NotFoundError') return; // chooser cancelled
              throw e;
            }
            await refresh();
            select(s);
            toast('Phone connected');
            onDone();
          })}>Choose phone</Button>
          <div className="note"><Info /><span>Works in Chrome, Edge or Brave on a computer. If the phone is "busy", another program on this computer holds it:
            run <code>adb kill-server</code> and close Android Studio / scrcpy. Next time it reconnects by itself when plugged in.</span></div>
        </>
      ) : (
        <>
          <p style={{ margin: 0 }} className="muted">Already on USB? Switch it to Wi-Fi so you can unplug the cable.</p>
          <Button icon={Wifi} loading={busy === 'wifi'} onClick={() => run('wifi', async () => {
            const d = devices.find((x) => x.serial === serial);
            if (!d) throw new Error('Select a USB device first');
            if (d.transport === 'wifi') throw new Error('That device is already on Wi-Fi');
            setOut('Switching the phone to Wi-Fi debugging… (up to ~10 s)');
            const r = await api('/api/wireless/usb-to-wifi', { body: { serial } });
            setOut(r.output);
            if (!r.ok) throw new Error('Could not connect over Wi-Fi — see details below');
            toast('Connected over Wi-Fi — you can unplug the cable');
            refresh();
          })}>Switch USB → Wi-Fi</Button>
        </>
      )}
    </>
  );
}

let qrLib: Promise<(t: number, e: string) => { addData: (s: string) => void; make: () => void; createSvgTag: (o: object) => string }> | null = null;
const loadQr = () => (qrLib ??= new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
  s.onload = () => resolve((window as unknown as { qrcode: never }).qrcode);
  s.onerror = () => { qrLib = null; reject(new Error('Could not load the QR library (offline?) — use the pairing code instead')); };
  document.head.append(s);
}));

function QrPanel() {
  const { refresh } = useDevices();
  const { toast } = useToast();
  const [svg, setSvg] = useState('');
  const [status, setStatus] = useState('Preparing…');
  const [n, setN] = useState(0);
  useEffect(() => {
    let poll: ReturnType<typeof setInterval>;
    (async () => {
      try {
        const [{ qr }, qrcode] = await Promise.all([api('/api/wireless/qr', { body: {} }), loadQr()]);
        const code = qrcode(0, 'M');
        code.addData(qr);
        code.make();
        setSvg(code.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
        setStatus('Waiting for the phone to scan…');
        poll = setInterval(async () => {
          const s = await api('/api/wireless/qr').catch(() => null);
          if (!s) return;
          setStatus(s.message ?? '');
          if (s.status === 'done') { clearInterval(poll); toast('Paired over Wi-Fi'); refresh(); }
          if (s.status === 'failed') clearInterval(poll);
        }, 1000);
      } catch (e) { setStatus((e as Error).message); }
    })();
    return () => clearInterval(poll);
  }, [n, refresh, toast]);
  return (
    <>
      <p style={{ margin: 0 }}>Android 11+: on the phone open <b>Developer options → Wireless debugging → Pair device with QR code</b> and scan this. Phone and PC must be on the same Wi-Fi.</p>
      <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="muted small" style={{ margin: 0, textAlign: 'center' }}>{status}</p>
      <Button icon={RefreshCw} onClick={() => setN(n + 1)}>New QR code</Button>
    </>
  );
}

function CodePanel({ setOut }: { setOut: (s: string) => void }) {
  const { toast } = useToast();
  const { busy, run } = useBusy();
  const [host, setHost] = useState('');
  const [code, setCode] = useState('');
  const [mdns, setMdns] = useState<{ name: string; type: string; addr: string }[]>([]);
  useEffect(() => {
    const load = () => api('/api/wireless/mdns').then(setMdns, () => {});
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <p style={{ margin: 0 }}>On the phone: <b>Wireless debugging → Pair device with pairing code</b>. Enter the IP:port and 6-digit code it shows.</p>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); run('pair', async () => {
        const r = await api('/api/wireless/pair', { body: { host: host.trim(), code: code.trim() } });
        setOut(r.output);
        if (!r.ok) throw new Error('Pairing failed');
        toast('Paired! Now connect with the IP:port on the main Wireless debugging screen.');
      }); }}>
        <input className="input mono grow" placeholder="192.168.1.20:37123" value={host} onChange={(e) => setHost(e.target.value)} required />
        <input className="input mono" style={{ width: 110 }} placeholder="123456" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required />
        <Button type="submit" variant="primary" icon={KeyRound} loading={busy === 'pair'}>Pair</Button>
      </form>
      {mdns.length > 0 && (
        <div className="panel">
          {mdns.map((s) => (
            <div key={s.addr + s.type} className="found">
              <span className="grow mono small">{s.addr} <span className="muted">{s.type.includes('pairing') ? 'pairing' : 'debugging'}</span></span>
              <Button size="sm" onClick={() => (s.type.includes('pairing') ? setHost(s.addr) : run('c', async () => {
                const r = await api('/api/wireless/connect', { body: { host: s.addr } });
                setOut(r.output);
                if (!r.ok) throw new Error('Connect failed');
              }))}>{s.type.includes('pairing') ? 'Use' : 'Connect'}</Button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function IpPanel({ setOut }: { setOut: (s: string) => void }) {
  const { devices, refresh } = useDevices();
  const { toast } = useToast();
  const { busy, run } = useBusy();
  const [host, setHost] = useState('');
  const wifi = devices.filter((d) => d.transport === 'wifi');
  return (
    <>
      <p style={{ margin: 0 }}>Connect to a paired phone, or one that ran <code>adb tcpip 5555</code>.</p>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); run('ip', async () => {
        const r = await api('/api/wireless/connect', { body: { host: host.trim() } });
        setOut(r.output);
        if (!r.ok) throw new Error('Connect failed');
        toast(`Connected to ${host}`);
        refresh();
      }); }}>
        <input className="input mono grow" placeholder="192.168.1.20:5555" value={host} onChange={(e) => setHost(e.target.value)} required />
        <Button type="submit" variant="primary" icon={Wifi} loading={busy === 'ip'}>Connect</Button>
      </form>
      <div className="chips">
        {wifi.map((d) => (
          <span key={d.serial} className="chip">{d.model || d.serial} · <span className="mono">{d.serial}</span>
            <Button size="sm" variant="ghost" icon={X} title="Disconnect" onClick={() => run(d.serial, async () => { await api('/api/wireless/disconnect', { body: { serial: d.serial } }); refresh(); })} />
          </span>
        ))}
        {!wifi.length && <span className="muted small">No Wi-Fi devices connected</span>}
      </div>
    </>
  );
}
