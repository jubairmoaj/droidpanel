import { useEffect, useState } from 'react';
import { ExternalLink, FileUp, Keyboard, ScrollText, Send, SquareTerminal, Play } from 'lucide-react';
import { api } from '../core/api.js';
import { useDevices } from '../state';
import { Button, SectionHead, store, useBusy, useToast } from '../ui';
import { DropZone } from './Apps';

export function Tools({ active, apps }: { active: boolean; apps: string[] }) {
  const { serial } = useDevices();
  const { toast, fail } = useToast();
  const { busy, run } = useBusy();
  const [url, setUrl] = useState('');
  const [pkg, setPkg] = useState('');
  const [text, setText] = useState('');
  const [cmd, setCmd] = useState('');
  const [out, setOut] = useState('');
  const [history] = useState<string[]>(() => { try { return JSON.parse(store.get('shellHistory', '[]')); } catch { return []; } });
  const [hi, setHi] = useState(history.length);
  const [log, setLog] = useState<string[]>([]);
  const need = () => { if (!serial) throw new Error('Select a device first'); return serial; };

  useEffect(() => { if (active) api('/api/log').then(setLog, () => setLog([])); }, [active]);

  const push = async (file: File) => {
    try {
      toast(`Sending ${file.name}…`);
      const r = await api(`/api/push?serial=${encodeURIComponent(need())}&name=${encodeURIComponent(file.name)}`, { body: file, raw: true, headers: { 'content-type': 'application/octet-stream' } });
      if (!r.ok) throw new Error(r.output);
      toast(`Saved to ${r.remote}`);
    } catch (e) { fail(e); }
  };

  return (
    <>
      <div className="tools">
        <section className="panel panel-pad tool">
          <SectionHead icon={ExternalLink} title="Open a deep link or URL" />
          <form onSubmit={(e) => { e.preventDefault(); run('link', async () => {
            const r = await api('/api/open-url', { body: { serial: need(), url: url.trim(), pkg: pkg.trim() || undefined } });
            if (!r.ok) throw new Error(r.output);
            toast('Opened');
          }); }}>
            <input className="input mono" placeholder="myapp://product/42 or https://…" value={url} onChange={(e) => setUrl(e.target.value)} required />
            <input className="input mono" list="dp-tool-pkgs" placeholder="Package (optional)" value={pkg} onChange={(e) => setPkg(e.target.value)} />
            <datalist id="dp-tool-pkgs">{apps.map((p) => <option key={p} value={p} />)}</datalist>
            <Button type="submit" variant="primary" icon={ExternalLink} loading={busy === 'link'}>Open</Button>
          </form>
        </section>
        <section className="panel panel-pad tool">
          <SectionHead icon={Keyboard} title="Type text on the phone">Goes into the focused field</SectionHead>
          <form onSubmit={(e) => { e.preventDefault(); run('text', async () => {
            await api('/api/input', { body: { serial: need(), type: 'text', text } });
            setText('');
            toast('Sent');
          }); }}>
            <input className="input" placeholder="Text to type" value={text} onChange={(e) => setText(e.target.value)} required />
            <Button type="submit" icon={Send} loading={busy === 'text'}>Send</Button>
          </form>
        </section>
      </div>
      <section className="tool">
        <SectionHead icon={FileUp} title="Push a file">Saved to /sdcard/Download</SectionHead>
        <DropZone icon={FileUp} onFile={push}>Drop any file here, or</DropZone>
      </section>
      <section className="tool">
        <SectionHead icon={SquareTerminal} title="ADB shell">↑ / ↓ for history</SectionHead>
        <form className="toolbar" onSubmit={(e) => { e.preventDefault(); const c = cmd.trim(); if (!c) return; run('shell', async () => {
          const r = await api('/api/shell', { body: { serial: need(), cmd: c } });
          setOut(`$ ${c}\n${r.output || '(no output)'}${r.ok ? '' : `\n[exit ${r.code}]`}`);
          if (history.at(-1) !== c) history.push(c);
          history.splice(0, Math.max(0, history.length - 50));
          setHi(history.length);
          store.set('shellHistory', JSON.stringify(history));
        }); }}>
          <input className="input mono grow" placeholder="e.g. dumpsys activity top | head -20" autoComplete="off" value={cmd} onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
              e.preventDefault();
              const i = Math.max(0, Math.min(history.length, hi + (e.key === 'ArrowUp' ? -1 : 1)));
              setHi(i);
              setCmd(history[i] ?? '');
            }} />
          <Button type="submit" variant="primary" icon={Play} loading={busy === 'shell'}>Run</Button>
        </form>
        {out && <pre className="console shell-out scroll-thin">{out}</pre>}
      </section>
      <section className="tool">
        <SectionHead icon={ScrollText} title="Panel log" right={<Button size="sm" variant="ghost" onClick={() => api('/api/log').then(setLog, fail)}>Refresh</Button>} />
        <pre className="console shell-out scroll-thin">{log.join('\n') || '(empty)'}</pre>
      </section>
    </>
  );
}
