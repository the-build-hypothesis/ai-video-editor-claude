import { useEffect, useState } from 'react';
import type { ProjectSummaryDTO } from '../../shared/api-types';
import { api, assetThumbUrl } from '../api';
import { useEditor } from '../store';
import { navigate } from '../main';
import { Icon, Modal, confirmDialog, promptDialog } from '../components/ui';
import { formatShort } from '../../shared/time';
import { AccountMenu } from '../components/AccountMenu';

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectSummaryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const user = useEditor((s) => s.user);
  const toast = useEditor((s) => s.toast);

  const load = async () => {
    setError(null);
    try {
      const r = await api.listProjects();
      setProjects(r.projects);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const rename = async (p: ProjectSummaryDTO) => {
    const name = await promptDialog({ title: 'Rename project', defaultValue: p.name, confirmLabel: 'Rename' });
    if (!name || name.trim() === p.name) return;
    try {
      await api.renameProject(p.id, name.trim());
      toast('success', 'Project renamed');
      void load();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  const del = async (p: ProjectSummaryDTO) => {
    const ok = await confirmDialog({ title: `Delete "${p.name}"?`, message: 'This permanently deletes the project and its export history. Media in your library is kept.', confirmLabel: 'Delete project', danger: true });
    if (!ok) return;
    try {
      await api.deleteProject(p.id);
      toast('success', 'Project deleted');
      void load();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  const dup = async (p: ProjectSummaryDTO) => {
    try {
      await api.duplicateProject(p.id);
      toast('success', 'Project duplicated');
      void load();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  return (
    <div className="dash">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>▶</span> FrameForge
        </div>
        <div className="spacer" />
        {user?.isAdmin && (
          <button className="btn btn-ghost" onClick={() => navigate('/admin')}>
            Admin
          </button>
        )}
        <AccountMenu />
      </header>
      <main className="dash-main">
        {user?.isGuest && (
          <div className="banner" role="note">
            <strong>Guest session.</strong> Your projects are kept for 7 days on this browser only.{' '}
            <button className="link" onClick={() => navigate('/login')}>
              Create a free account
            </button>{' '}
            to keep them permanently and sign in anywhere.
          </div>
        )}
        <div className="dash-head">
          <h1>Projects</h1>
          <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="new-project">
            <Icon name="plus" /> New project
          </button>
        </div>
        {error && (
          <div className="error-box" role="alert">
            Could not load projects: {error}{' '}
            <button className="btn btn-sm" onClick={load}>
              Retry
            </button>
          </div>
        )}
        {projects === null && !error && <div className="spinner" aria-label="Loading projects" />}
        {projects?.length === 0 && (
          <div className="empty">
            <Icon name="film" size={40} />
            <h2>No projects yet</h2>
            <p className="muted">Create a project, import clips and music, then arrange them on the timeline. Export an MP4 when you're done.</p>
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Create your first project
            </button>
          </div>
        )}
        <ul className="project-grid">
          {projects?.map((p) => (
            <li key={p.id} className="project-card">
              <button className="project-thumb" onClick={() => navigate(`/project/${p.id}`)} aria-label={`Open ${p.name}`}>
                {p.thumbnailAssetId ? <img src={assetThumbUrl(p.thumbnailAssetId)} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /> : <Icon name="film" size={32} />}
              </button>
              <div className="project-meta">
                <button className="project-name link" onClick={() => navigate(`/project/${p.id}`)}>
                  {p.name}
                </button>
                <div className="muted small">
                  {formatShort(p.durationUs)} · edited {new Date(p.updatedAt).toLocaleString()}
                </div>
              </div>
              <div className="project-actions">
                <button className="icon-btn" title="Rename" aria-label={`Rename ${p.name}`} onClick={() => rename(p)}>
                  <Icon name="text" />
                </button>
                <button className="icon-btn" title="Duplicate" aria-label={`Duplicate ${p.name}`} onClick={() => dup(p)}>
                  <Icon name="dup" />
                </button>
                <button className="icon-btn danger" title="Delete" aria-label={`Delete ${p.name}`} onClick={() => del(p)}>
                  <Icon name="trash" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </main>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('Untitled project');
  const [aspect, setAspect] = useState('16:9');
  const [fps, setFps] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.createProject(name.trim() || 'Untitled project', aspect, fps);
      navigate(`/project/${r.project.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
        </label>
        <fieldset className="field">
          <legend className="field-label">Format</legend>
          <div className="aspect-choices">
            {[
              ['16:9', '1920×1080', 'Landscape'],
              ['9:16', '1080×1920', 'Vertical'],
              ['1:1', '1080×1080', 'Square'],
            ].map(([a, dims, label]) => (
              <label key={a} className={`aspect-choice ${aspect === a ? 'active' : ''}`}>
                <input type="radio" name="aspect" value={a} checked={aspect === a} onChange={() => setAspect(a)} />
                <span className={`aspect-box aspect-${a.replace(':', 'x')}`} aria-hidden />
                <span>
                  {label} {a}
                  <br />
                  <span className="muted small">{dims}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span className="field-label">Frame rate</span>
          <select className="input" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
            {[24, 25, 30, 50, 60].map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </label>
        {error && <div className="error-box">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
