/**
 * Editor state (zustand). Every project mutation goes through `edit()` which runs a pure command
 * from shared/commands.ts, validates the result, pushes the previous snapshot onto the undo stack
 * and schedules an autosave. Undo/redo restore whole snapshots (projects are small JSON).
 */
import { create } from 'zustand';
import type { AssetDTO, UserDTO } from '../shared/api-types';
import type { AssetIndex, Clip, Project } from '../shared/model';
import { migrateProject } from '../shared/migrate';
import { CommandError, type CommandContext } from '../shared/commands';
import { api, ApiError } from './api';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'offline';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
  action?: { label: string; run: () => void };
}

export interface UploadItem {
  id: string;
  name: string;
  progress: number;
  status: 'probing' | 'uploading' | 'error' | 'done';
  error?: string;
  file: File;
  abort?: AbortController;
}

interface EditorState {
  user: UserDTO | null;
  authChecked: boolean;
  project: Project | null;
  projectVersion: number;
  past: { project: Project; label: string }[];
  future: { project: Project; label: string }[];
  saveState: SaveState;
  saveError: string | null;
  lastSavedAt: number | null;
  assets: AssetDTO[];
  storage: { bytes: number; limitBytes: number } | null;
  uploads: UploadItem[];
  selection: string[];
  selectedCaption: string | null;
  playhead: number;
  playing: boolean;
  zoom: number; // px per second
  snapping: boolean;
  clipboard: { trackId: string; clip: Clip }[];
  toasts: Toast[];
  rightTab: 'inspector' | 'captions' | 'ai' | 'export';
  setUser(u: UserDTO | null): void;
  loadProject(id: string): Promise<void>;
  closeProject(): void;
  edit(label: string, fn: (p: Project, ctx: CommandContext) => Project, opts?: { select?: string[] }): boolean;
  undo(): void;
  redo(): void;
  select(ids: string[]): void;
  setPlayhead(t: number): void;
  setPlaying(b: boolean): void;
  setZoom(z: number): void;
  toast(kind: Toast['kind'], text: string, action?: Toast['action']): void;
  dismissToast(id: number): void;
  refreshAssets(): Promise<void>;
  saveNow(): Promise<void>;
  resolveConflict(mode: 'reload' | 'overwrite'): Promise<void>;
  set(partial: Partial<EditorState>): void;
}

let toastId = 1;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> | null = null;
const HISTORY_LIMIT = 200;

export function assetIndex(assets: AssetDTO[]): AssetIndex {
  const idx: AssetIndex = {};
  for (const a of assets) {
    idx[a.id] = {
      id: a.id,
      name: a.name,
      kind: a.kind,
      durationUs: a.metadata.durationUs,
      width: a.metadata.width,
      height: a.metadata.height,
      hasAudio: a.metadata.hasAudio,
    };
  }
  return idx;
}

let cachedIdx: { assets: AssetDTO[]; idx: AssetIndex } | null = null;
export function getAssetIndex(): AssetIndex {
  const a = useEditor.getState().assets;
  if (!cachedIdx || cachedIdx.assets !== a) cachedIdx = { assets: a, idx: assetIndex(a) };
  return cachedIdx.idx;
}

export const useEditor = create<EditorState>((set, get) => ({
  user: null,
  authChecked: false,
  project: null,
  projectVersion: 0,
  past: [],
  future: [],
  saveState: 'saved',
  saveError: null,
  lastSavedAt: null,
  assets: [],
  storage: null,
  uploads: [],
  selection: [],
  selectedCaption: null,
  playhead: 0,
  playing: false,
  zoom: 60,
  snapping: true,
  clipboard: [],
  toasts: [],
  rightTab: 'inspector',

  set: (partial) => set(partial),
  setUser: (u) => set({ user: u, authChecked: true }),

  async loadProject(id) {
    const { project } = await api.getProject(id);
    const p = migrateProject(project.data);
    set({ project: p, projectVersion: project.version, past: [], future: [], saveState: 'saved', selection: [], playhead: 0, playing: false, selectedCaption: null, lastSavedAt: Date.now() });
    await get().refreshAssets();
  },

  closeProject() {
    if (saveTimer) clearTimeout(saveTimer);
    set({ project: null, past: [], future: [], selection: [] });
  },

  edit(label, fn, opts) {
    const p = get().project;
    if (!p) return false;
    try {
      const next = fn(p, { assets: getAssetIndex() });
      if (next === p) return false;
      const past = [...get().past, { project: p, label }].slice(-HISTORY_LIMIT);
      set({ project: next, past, future: [], saveState: 'dirty', ...(opts?.select ? { selection: opts.select } : {}) });
      scheduleSave();
      return true;
    } catch (e) {
      const msg = e instanceof CommandError ? e.message : e instanceof Error ? e.message : String(e);
      get().toast('error', `${label} failed: ${msg}`);
      return false;
    }
  },

  undo() {
    const { past, project, future } = get();
    if (!past.length || !project) return;
    const prev = past[past.length - 1];
    set({ project: prev.project, past: past.slice(0, -1), future: [{ project, label: prev.label }, ...future], saveState: 'dirty' });
    get().toast('info', `Undo: ${prev.label}`);
    scheduleSave();
  },

  redo() {
    const { past, project, future } = get();
    if (!future.length || !project) return;
    const next = future[0];
    set({ project: next.project, future: future.slice(1), past: [...past, { project, label: next.label }], saveState: 'dirty' });
    get().toast('info', `Redo: ${next.label}`);
    scheduleSave();
  },

  select: (ids) => set({ selection: ids }),
  setPlayhead: (t) => set({ playhead: Math.max(0, Math.round(t)) }),
  setPlaying: (b) => set({ playing: b }),
  setZoom: (z) => set({ zoom: Math.min(800, Math.max(4, z)) }),

  toast(kind, text, action) {
    const id = toastId++;
    set({ toasts: [...get().toasts, { id, kind, text, action }].slice(-5) });
    if (kind !== 'error' || !action) setTimeout(() => get().dismissToast(id), kind === 'error' ? 9000 : 3500);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  async refreshAssets() {
    try {
      const r = await api.listAssets();
      set({ assets: r.assets, storage: r.usage });
    } catch (e) {
      get().toast('error', `Could not load media library: ${(e as Error).message}`);
    }
  },

  async saveNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (saving) await saving;
    const st = get();
    if (!st.project || st.saveState === 'saved' || st.saveState === 'conflict') return;
    const snapshot = st.project;
    set({ saveState: 'saving' });
    saving = (async () => {
      try {
        const r = await api.saveProject(snapshot.id, snapshot, get().projectVersion);
        // The editor may have switched projects while this save was in flight: ignore stale responses.
        if (get().project?.id !== snapshot.id) return;
        const stillSame = get().project === snapshot;
        set({ projectVersion: r.project.version, saveState: stillSame ? 'saved' : 'dirty', saveError: null, lastSavedAt: Date.now() });
        if (!stillSame) scheduleSave();
      } catch (e) {
        if (get().project?.id !== snapshot.id) return;
        if (e instanceof ApiError && e.status === 409) {
          set({ saveState: 'conflict', saveError: 'This project was changed in another tab or device.' });
        } else if (e instanceof ApiError && e.status === 0) {
          set({ saveState: 'offline', saveError: e.message });
          saveTimer = setTimeout(() => void get().saveNow(), 5000);
        } else {
          set({ saveState: 'error', saveError: (e as Error).message });
          saveTimer = setTimeout(() => void get().saveNow(), 8000);
        }
      } finally {
        saving = null;
      }
    })();
    await saving;
  },

  async resolveConflict(mode) {
    const p = get().project;
    if (!p) return;
    const { project: server } = await api.getProject(p.id);
    if (mode === 'reload') {
      set({ project: migrateProject(server.data), projectVersion: server.version, saveState: 'saved', past: [], future: [], saveError: null });
    } else {
      set({ projectVersion: server.version, saveState: 'dirty', saveError: null });
      await get().saveNow();
    }
  },
}));

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void useEditor.getState().saveNow(), 1200);
}

// Warn before leaving with unsaved edits; also try to flush.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    const s = useEditor.getState().saveState;
    if (s === 'dirty' || s === 'saving' || s === 'error' || s === 'offline') {
      void useEditor.getState().saveNow();
      e.preventDefault();
    }
  });
}
