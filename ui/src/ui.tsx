// Small UI primitives shared by every screen.
import { createContext, useCallback, useContext, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Loader2, type LucideIcon } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft' | 'warn-soft' | 'accent-soft';

export function Button({
  variant = 'secondary', size, icon: Icon, loading, active, className = '', children, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant; size?: 'sm' | 'lg'; icon?: LucideIcon; loading?: boolean; active?: boolean;
}) {
  const cls = ['btn', variant !== 'secondary' && variant, size, !children && 'icon', active && 'active', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={loading || rest.disabled} {...rest}>
      {loading ? <Loader2 className="spin" /> : Icon && <Icon />}
      {children != null && children !== false && <span>{children}</span>}
    </button>
  );
}

export function Badge({ tone, pulse, children }: { tone?: 'success' | 'danger' | 'warning' | 'info'; pulse?: boolean; children: ReactNode }) {
  return <span className={`badge ${tone ?? ''}`}>{pulse && <i className="pulse" />}{children}</span>;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch"
      disabled={disabled} onClick={(e) => { e.stopPropagation(); onChange(!checked); }} />
  );
}

export function Empty({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon />
      <h4>{title}</h4>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function SectionHead({ icon: Icon, title, children, right }: { icon?: LucideIcon; title: string; children?: ReactNode; right?: ReactNode }) {
  return (
    <div className="section-head">
      <h3>{Icon && <Icon />}{title}</h3>
      {children && <p>{children}</p>}
      {right && <><span className="spacer" />{right}</>}
    </div>
  );
}

// ── Toasts ──────────────────────────────────────────────────────────────────

type Toast = { id: number; text: string; error: boolean };
type ToastApi = { toast: (text: string, error?: boolean) => void; fail: (e: unknown) => void };
const ToastCtx = createContext<ToastApi>({ toast: () => {}, fail: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const next = useRef(1);
  const toast = useCallback((text: string, error = false) => {
    const id = next.current++;
    setItems((l) => [...l.slice(-4), { id, text, error }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), error ? 6500 : 3200);
  }, []);
  const fail = useCallback((e: unknown) => toast(e instanceof Error ? e.message : String(e), true), [toast]);
  const api = useRef<ToastApi>({ toast, fail }).current;
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.error ? ' error' : ''}`}>
            {t.error ? <CircleAlert /> : <CircleCheck />}<span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Run an async action with a busy flag; errors become toasts. */
export function useBusy() {
  const { fail } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key);
    try { return await fn(); } catch (e) { fail(e); return undefined; } finally { setBusy(null); }
  }, [fail]);
  return { busy, run };
}

// ── Misc helpers ────────────────────────────────────────────────────────────

export const store = {
  get(k: string, d = '') { try { return localStorage.getItem(`dp.${k}`) ?? d; } catch { return d; } },
  set(k: string, v: string) { try { localStorage.setItem(`dp.${k}`, v); } catch { /* private mode */ } },
};

export function downloadUrl(url: string, name?: string) {
  const a = document.createElement('a');
  a.href = url;
  if (name) a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}

export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Stable colour for an app icon from its package name. */
export function pkgColor(pkg: string) {
  let h = 0;
  for (const c of pkg) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}
export const pkgInitial = (pkg: string) => (pkg.split('.').filter((p) => !['com', 'org', 'net', 'io', 'app', 'android'].includes(p)).pop() ?? pkg)[0]?.toUpperCase() ?? '?';
