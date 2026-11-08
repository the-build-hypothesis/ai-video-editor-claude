import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useEditor } from '../store';

// ------------------------------------------------------------- icons (inline SVG, no external deps)
const PATHS: Record<string, string> = {
  play: 'M7 4v16l13-8z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-4',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 000 10h4',
  split: 'M12 2v20M5 8l-3 4 3 4M19 8l3 4-3 4',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  magnet: 'M6 4v8a6 6 0 0012 0V4h-4v8a2 2 0 01-4 0V4z',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeOff: 'M3 3l18 18M10.6 6.1A10 10 0 0112 6c7 0 11 6 11 6a17 17 0 01-3.2 3.8M6.6 6.6C3.4 8.5 1 12 1 12s4 7 11 7a10 10 0 005.4-1.6',
  volume: 'M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 010 7M19 5a10 10 0 010 14',
  mute: 'M11 5L6 9H2v6h4l5 4zM23 9l-6 6M17 9l6 6',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 018 0v4',
  unlock: 'M5 11h14v10H5zM8 11V7a4 4 0 017.9-1',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  zoomIn: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5M11 8v6M8 11h6',
  zoomOut: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5M8 11h6',
  keyboard: 'M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  sparkle: 'M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  cc: 'M3 5h18v14H3zM10 10.5a2 2 0 10-.01 3M17 10.5a2 2 0 10-.01 3',
  export: 'M12 3v12M7 8l5-5 5 5M5 14v6h14v-6',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  back: 'M15 18l-6-6 6-6',
  fullscreen: 'M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6',
  grid: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  film: 'M3 3h18v18H3zM7 3v18M17 3v18M3 8h4M3 13h4M17 8h4M17 13h4',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM21 16a3 3 0 11-6 0 3 3 0 016 0z',
  image: 'M3 3h18v18H3zM8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM21 15l-5-5L5 21',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6L6 18',
  retry: 'M1 4v6h6M3.5 15a9 9 0 102.1-9.4L1 10',
  dup: 'M9 9h11v11H9zM5 15H4V4h11v1',
  fadeIn: 'M3 20L21 4v16z',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
};

export function Icon({ name, size = 16, title }: { name: keyof typeof PATHS | string; size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={PATHS[name] ?? ''} fill={name === 'play' ? 'currentColor' : 'none'} />
    </svg>
  );
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  const dismiss = useEditor((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
          <span>{t.text}</span>
          {t.action && (
            <button className="btn btn-sm" onClick={() => { t.action!.run(); dismiss(t.id); }}>
              {t.action.label}
            </button>
          )}
          <button className="icon-btn" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------- promise-based dialogs
interface DialogReq {
  id: number;
  kind: 'confirm' | 'prompt';
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  defaultValue?: string;
  resolve: (v: string | boolean | null) => void;
}
const useDialogs = create<{ queue: DialogReq[] }>(() => ({ queue: [] }));
let dialogId = 1;

export function confirmDialog(opts: { title: string; message?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogs.setState((s) => ({ queue: [...s.queue, { id: dialogId++, kind: 'confirm', ...opts, resolve: (v) => resolve(v === true) }] }));
  });
}
export function promptDialog(opts: { title: string; message?: string; defaultValue?: string; confirmLabel?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.setState((s) => ({ queue: [...s.queue, { id: dialogId++, kind: 'prompt', ...opts, resolve: (v) => resolve(typeof v === 'string' ? v : null) }] }));
  });
}

export function DialogHost() {
  const queue = useDialogs((s) => s.queue);
  const d = queue[0];
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!d) return;
    setValue(d.defaultValue ?? '');
    setTimeout(() => (d.kind === 'prompt' ? inputRef.current?.select() : okRef.current?.focus()), 0);
  }, [d]);
  if (!d) return null;
  const close = (v: string | boolean | null) => {
    d.resolve(v);
    useDialogs.setState((s) => ({ queue: s.queue.slice(1) }));
  };
  return (
    <Modal title={d.title} onClose={() => close(d.kind === 'prompt' ? null : false)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          close(d.kind === 'prompt' ? value : true);
        }}
      >
        {d.message && <p className="muted">{d.message}</p>}
        {d.kind === 'prompt' && <input ref={inputRef} className="input" value={value} onChange={(e) => setValue(e.target.value)} aria-label={d.title} maxLength={120} />}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => close(d.kind === 'prompt' ? null : false)}>
            Cancel
          </button>
          <button ref={okRef} type="submit" className={`btn ${d.danger ? 'btn-danger' : 'btn-primary'}`}>
            {d.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close dialog" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Number input that commits on blur/Enter (precise inspector editing). */
export function NumField({
  label,
  value,
  onCommit,
  step = 0.1,
  min,
  max,
  suffix,
  decimals = 2,
  disabled,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  decimals?: number;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value.toFixed(decimals));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(Number.isFinite(value) ? String(Number(value.toFixed(decimals))) : '');
  }, [value, focused, decimals]);
  const numRef = useRef<HTMLInputElement>(null);
  const commit = () => {
    // Read the live DOM value: the blur handler's closure can be one render behind the last keystroke.
    const v = parseFloat(numRef.current?.value ?? text);
    if (!Number.isFinite(v)) {
      setText(String(Number(value.toFixed(decimals))));
      return;
    }
    let c = v;
    if (min !== undefined) c = Math.max(min, c);
    if (max !== undefined) c = Math.min(max, c);
    if (Math.abs(c - value) > 1e-9) onCommit(c);
    setText(String(Number(c.toFixed(decimals))));
  };
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input">
        <input
          type="number"
          ref={numRef}
          className="input input-num"
          aria-label={label}
          value={text}
          step={step}
          min={min}
          max={max}
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            e.stopPropagation();
          }}
        />
        {suffix && <span className="suffix" aria-hidden="true">{suffix}</span>}
      </span>
    </label>
  );
}

export function RangeField({ label, value, min, max, step, onCommit, format }: { label: string; value: number; min: number; max: number; step: number; onCommit: (v: number) => void; format?: (v: number) => string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="field field-range">
      <span className="field-label">
        {label} <span className="muted">{format ? format(v) : v.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => setV(parseFloat(e.target.value))}
        onPointerUp={() => v !== value && onCommit(v)}
        onKeyUp={() => v !== value && onCommit(v)}
        onBlur={() => v !== value && onCommit(v)}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </label>
  );
}
