import { useEffect, useState } from 'react';
import { useEditor } from '../store';
import { navigate } from '../main';
import { Icon, Modal, promptDialog } from '../components/ui';
import { MediaPanel } from '../components/MediaPanel';
import { PreviewPanel } from '../components/PreviewPanel';
import { Timeline } from '../components/Timeline';
import { Inspector } from '../components/Inspector';
import { CaptionsPanel } from '../components/CaptionsPanel';
import { AiPanel } from '../components/AiPanel';
import { ExportPanel } from '../components/ExportPanel';
import { AccountMenu } from '../components/AccountMenu';
import * as A from '../actions';
import { renameProject } from '../../shared/commands';
import { ApiError, api } from '../api';

export function EditorPage({ projectId }: { projectId: string }) {
  const project = useEditor((s) => s.project);
  const [error, setError] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);

  useEffect(() => {
    let cancelled = false;
    useEditor
      .getState()
      .loadProject(projectId)
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError && e.status === 404 ? 'Project not found, or you do not have access to it.' : (e as Error).message);
      });
    return () => {
      cancelled = true;
      // Flush pending edits (waiting for any in-flight save) before releasing the project.
      void useEditor
        .getState()
        .saveNow()
        .finally(() => {
          if (useEditor.getState().project?.id === projectId) useEditor.getState().closeProject();
        });
    };
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('.modal-backdrop')) return;
      const mod = e.ctrlKey || e.metaKey;
      const st = useEditor.getState();
      const k = e.key;
      let handled = true;
      if (k === ' ' || k === 'k' || k === 'K') void A.togglePlay();
      else if (mod && (k === 'z' || k === 'Z') && e.shiftKey) st.redo();
      else if (mod && (k === 'z' || k === 'Z')) st.undo();
      else if (mod && (k === 'y' || k === 'Y')) st.redo();
      else if (mod && (k === 'c' || k === 'C')) A.copySelection();
      else if (mod && (k === 'v' || k === 'V')) A.pasteClipboard();
      else if (mod && (k === 'd' || k === 'D')) A.duplicateSelection();
      else if (mod && (k === 's' || k === 'S')) void st.saveNow();
      else if (mod && (k === 'a' || k === 'A')) st.select(st.project?.tracks.flatMap((t) => (t.locked ? [] : t.clips.map((c) => c.id))) ?? []);
      else if (!mod && (k === 's' || k === 'S')) A.splitAtPlayhead();
      else if (k === 'Delete' || k === 'Backspace') A.deleteSelection(e.shiftKey);
      else if (e.altKey && (k === 'ArrowLeft' || k === 'ArrowRight') && st.selection.length) A.nudgeSelection((k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? st.project?.settings.fps ?? 30 : 1));
      else if (k === 'ArrowLeft') A.stepFrames(e.shiftKey ? -(st.project?.settings.fps ?? 30) : -1);
      else if (k === 'ArrowRight') A.stepFrames(e.shiftKey ? st.project?.settings.fps ?? 30 : 1);
      else if (k === 'Home') A.seek(0);
      else if (k === 'End') A.seek(Infinity);
      else if (k === '=' || k === '+') st.setZoom(st.zoom * 1.25);
      else if (k === '-' || k === '_') st.setZoom(st.zoom / 1.25);
      else if (k === 'n' || k === 'N') st.set({ snapping: !st.snapping });
      else if (k === 't' || k === 'T') A.addTextPreset('title');
      else if (k === '?') setShowKeys(true);
      else if (k === 'Escape') st.set({ selection: [], selectedCaption: null });
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (error)
    return (
      <div className="center-screen">
        <div className="error-box" role="alert">
          {error}
        </div>
        <button className="btn" onClick={() => navigate('/')}>
          Back to projects
        </button>
      </div>
    );
  if (!project)
    return (
      <div className="center-screen">
        <div className="spinner" role="status" aria-label="Loading project" />
        <p className="muted">Loading project…</p>
      </div>
    );

  return (
    <div className="editor">
      <TopBar onShowKeys={() => setShowKeys(true)} />
      <aside className="panel left-panel" aria-label="Media library">
        <MediaPanel />
      </aside>
      <section className="center-panel" aria-label="Preview">
        <PreviewPanel />
      </section>
      <aside className="panel right-panel" aria-label="Properties">
        <RightPanel />
      </aside>
      <section className="bottom-panel" aria-label="Timeline">
        <Timeline />
      </section>
      {showKeys && <ShortcutsDialog onClose={() => setShowKeys(false)} />}
    </div>
  );
}

function RightPanel() {
  const tab = useEditor((s) => s.rightTab);
  const set = useEditor((s) => s.set);
  const tabs: [typeof tab, string, string][] = [
    ['inspector', 'Inspector', 'sliders'],
    ['captions', 'Captions', 'cc'],
    ['ai', 'AI', 'sparkle'],
    ['export', 'Export', 'export'],
  ];
  return (
    <>
      <div className="tabs" role="tablist" aria-label="Side panels">
        {tabs.map(([id, label, icon]) => (
          <button key={id} role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`tabpanel-${id}`} className={tab === id ? 'active' : ''} onClick={() => set({ rightTab: id })} data-testid={`tab-${id}`}>
            <Icon name={icon} size={14} /> {label}
          </button>
        ))}
      </div>
      <div className="tab-body" role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'inspector' && <Inspector />}
        {tab === 'captions' && <CaptionsPanel />}
        {tab === 'ai' && <AiPanel />}
        {tab === 'export' && <ExportPanel />}
      </div>
    </>
  );
}

function SaveIndicator() {
  const s = useEditor((x) => x.saveState);
  const err = useEditor((x) => x.saveError);
  const resolve = useEditor((x) => x.resolveConflict);
  const label = { saved: 'All changes saved', dirty: 'Unsaved changes…', saving: 'Saving…', error: 'Save failed — retrying', conflict: 'Conflict', offline: 'Offline — will retry' }[s];
  return (
    <div className={`save-ind save-${s}`} role="status" aria-live="polite" title={err ?? undefined} data-testid="save-state" data-state={s}>
      <span className="dot" aria-hidden /> {label}
      {s === 'error' && (
        <button className="btn btn-sm" onClick={() => void useEditor.getState().saveNow()}>
          Retry now
        </button>
      )}
      {s === 'conflict' && (
        <>
          <button className="btn btn-sm" onClick={() => void resolve('reload')} title="Discard local changes and load the latest saved version">
            Load latest
          </button>
          <button className="btn btn-sm" onClick={() => void resolve('overwrite')} title="Keep my version and overwrite">
            Keep mine
          </button>
        </>
      )}
    </div>
  );
}

function TopBar({ onShowKeys }: { onShowKeys: () => void }) {
  const project = useEditor((s) => s.project)!;
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const undoLabel = useEditor((s) => s.past[s.past.length - 1]?.label);
  const redoLabel = useEditor((s) => s.future[0]?.label);
  const user = useEditor((s) => s.user);
  const [revOpen, setRevOpen] = useState(false);
  const rename = async () => {
    const name = await promptDialog({ title: 'Rename project', defaultValue: project.name, confirmLabel: 'Rename' });
    if (name && name.trim() && name.trim() !== project.name) useEditor.getState().edit('Rename project', (p) => renameProject(p, { name }));
  };
  return (
    <header className="topbar editor-top">
      <button className="icon-btn" aria-label="Back to projects" title="Back to projects" onClick={() => navigate('/')}>
        <Icon name="back" />
      </button>
      <div className="brand small-brand" aria-hidden>
        <span className="brand-mark">▶</span>
      </div>
      <button className="project-title" onClick={rename} title="Rename project" data-testid="project-title">
        {project.name}
      </button>
      <span className="muted small">
        {project.settings.width}×{project.settings.height} · {project.settings.fps} fps
      </span>
      <SaveIndicator />
      <div className="spacer" />
      <button className="icon-btn" disabled={!canUndo} onClick={() => useEditor.getState().undo()} aria-label={`Undo ${undoLabel ?? ''}`} title={`Undo ${undoLabel ?? ''} (Ctrl+Z)`} data-testid="undo">
        <Icon name="undo" />
      </button>
      <button className="icon-btn" disabled={!canRedo} onClick={() => useEditor.getState().redo()} aria-label={`Redo ${redoLabel ?? ''}`} title={`Redo ${redoLabel ?? ''} (Ctrl+Shift+Z)`} data-testid="redo">
        <Icon name="redo" />
      </button>
      <button className="btn btn-ghost" onClick={() => setRevOpen(true)} title="Revision history">
        History
      </button>
      <button className="icon-btn" onClick={onShowKeys} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
        <Icon name="keyboard" />
      </button>
      {user?.isGuest && (
        <span className="pill pill-warn" title="Guest projects are kept for 7 days. Create an account to keep them.">
          Guest
        </span>
      )}
      <button className="btn btn-primary" onClick={() => useEditor.getState().set({ rightTab: 'export' })} data-testid="open-export">
        <Icon name="export" /> Export
      </button>
      <AccountMenu />
      {revOpen && <RevisionsDialog onClose={() => setRevOpen(false)} />}
    </header>
  );
}

function RevisionsDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project)!;
  const [revs, setRevs] = useState<{ version: number; createdAt: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void useEditor.getState().saveNow().then(() =>
      api
        .revisions(project.id)
        .then((r) => setRevs(r.revisions))
        .catch((e) => setErr(e.message)),
    );
  }, [project.id]);
  const restore = async (v: number) => {
    try {
      await useEditor.getState().saveNow();
      await api.restoreRevision(project.id, v);
      await useEditor.getState().loadProject(project.id);
      useEditor.getState().toast('success', `Restored revision v${v}`);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal title="Revision history" onClose={onClose}>
      <p className="muted small">Snapshots are saved automatically while you edit. Restoring creates a new version (it can itself be undone by restoring again).</p>
      {err && <div className="error-box">{err}</div>}
      {!revs && !err && <div className="spinner" />}
      {revs?.length === 0 && <p className="muted">No revisions yet.</p>}
      <ul className="rev-list">
        {revs?.map((r) => (
          <li key={r.version}>
            <span>
              v{r.version} · {new Date(r.createdAt).toLocaleString()}
            </span>
            <button className="btn btn-sm" onClick={() => restore(r.version)}>
              Restore
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Space / K', 'Play / pause'],
    ['← / →', 'Step one frame'],
    ['Shift + ← / →', 'Step one second'],
    ['Alt + ← / →', 'Nudge selected clips by one frame (Shift: one second)'],
    ['Home / End', 'Jump to start / end'],
    ['S', 'Split at playhead'],
    ['Delete / Backspace', 'Delete selected clips (Shift: ripple delete)'],
    ['Ctrl/⌘ + Z', 'Undo'],
    ['Ctrl/⌘ + Shift + Z, Ctrl + Y', 'Redo'],
    ['Ctrl/⌘ + C / V', 'Copy / paste clips at playhead'],
    ['Ctrl/⌘ + D', 'Duplicate selected clips'],
    ['Ctrl/⌘ + A', 'Select all clips'],
    ['Ctrl/⌘ + S', 'Save now'],
    ['T', 'Add title at playhead'],
    ['N', 'Toggle snapping'],
    ['+ / -', 'Zoom timeline'],
    ['Shift + click', 'Add clip to selection'],
    ['Alt + drag', 'Move clip without snapping'],
    ['Esc', 'Clear selection'],
    ['?', 'Show this help'],
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="keys-table">
        <tbody>
          {rows.map(([k, d]) => (
            <tr key={k}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
