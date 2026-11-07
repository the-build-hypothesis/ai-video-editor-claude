import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as cmd from '../../src/shared/commands';
import { migrateProject, MigrationError } from '../../src/shared/migrate';
import { ProjectSchema, SCHEMA_VERSION, type Project } from '../../src/shared/model';
import type { AssetDTO } from '../../src/shared/api-types';
import { S, assets, ctx, videoClip, audioClip, textClip, projectWith, getClip, deepFreeze } from './helpers';

// The store autosaves through the API client; keep tests offline and deterministic.
vi.mock('../../src/client/api', () => ({
  api: {
    saveProject: vi.fn(async () => ({ project: { version: 2 } })),
    getProject: vi.fn(),
    listAssets: vi.fn(async () => ({ assets: [], usage: { bytes: 0, limitBytes: 1 } })),
  },
  ApiError: class ApiError extends Error {},
}));

const { useEditor } = await import('../../src/client/store');

function richProject(): Project {
  return cmd.setCaptions(
    projectWith(
      {
        v2: [textClip('t1', S, 2 * S, { style: { color: '#ff00ff', background: '#00000080' }, animation: 'pop', preset: 'title' })],
        v1: [
          videoClip('c1', 0, 4 * S, { sourceStartUs: S, speed: 1.25, fadeInUs: 300_000, adjust: { brightness: 0.1, contrast: 0, saturation: -0.2 } }),
          videoClip('c2', 4 * S, 3 * S, { transitionIn: { type: 'dissolve', durationUs: 500_000 }, transform: { x: 12.5, crop: { left: 0.1 } } }),
        ],
        a1: [audioClip('m1', 0, 20 * S, { volume: 0.7, gainPoints: [{ tUs: 0, gain: 1 }, { tUs: S, gain: 0.25 }] })],
      },
      (p) => {
        p.tracks[3].muted = true;
        p.tracks[0].hidden = true;
      },
    ),
    { segments: [{ id: 'cap1', startUs: 0, endUs: S, text: 'Hello <b>world</b> "quoted" ünïcødé' }], language: 'en' },
  );
}

describe('serialization', () => {
  it('JSON round trip is lossless and re-validates', () => {
    const p = richProject();
    const back = ProjectSchema.parse(JSON.parse(JSON.stringify(p)));
    expect(back).toEqual(p);
    // Idempotent: parsing an already-parsed project yields the same object structure.
    expect(ProjectSchema.parse(back)).toEqual(back);
  });

  it('migrateProject accepts a current document unchanged', () => {
    const p = richProject();
    expect(migrateProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it('migrates a v1 document (spec §5.4 shape) to a valid v2 project', () => {
    const v1 = {
      schemaVersion: 1,
      projectId: 'legacy1',
      name: 'Old project',
      video: { width: 1280, height: 720, fps: 25 },
      tracks: [
        {
          id: 'trkV',
          type: 'video',
          clips: [
            { id: 'old1', assetId: 'vid10', timelineStartUs: 0, sourceStartUs: 500_000, durationUs: 2 * S, transform: { x: 10, scale: 1.2 }, effects: [] },
            { id: 'old2', assetId: 'vid10', timelineStartUs: 2 * S, durationUs: S, effects: [] },
          ],
        },
        { id: 'trkA', type: 'audio', clips: [{ id: 'olda', assetId: 'music', timelineStartUs: 0, durationUs: 3 * S }] },
      ],
    };
    const p = migrateProject(v1);
    expect(p.schemaVersion).toBe(SCHEMA_VERSION);
    expect(p.id).toBe('legacy1');
    expect(p.settings).toMatchObject({ width: 1280, height: 720, fps: 25 });
    expect(p.tracks.map((t) => [t.id, t.kind])).toEqual([
      ['trkV', 'video'],
      ['trkA', 'audio'],
    ]);
    const old1 = getClip(p, 'old1');
    expect(old1).toMatchObject({ kind: 'video', sourceStartUs: 500_000, durationUs: 2 * S });
    if (old1.kind !== 'video') throw new Error('kind');
    expect(old1.transform).toMatchObject({ x: 10, scale: 1.2, opacity: 1 });
    expect(getClip(p, 'old2')).toMatchObject({ sourceStartUs: 0 });
    expect(getClip(p, 'olda').kind).toBe('audio');
    expect(() => ProjectSchema.parse(p)).not.toThrow();
    // The migrated project is editable with the command layer.
    expect(() => cmd.splitClip(p, { clipId: 'old1', atUs: S })).not.toThrow();
  });

  it('v1 migration adds missing track kinds and defaults', () => {
    const p = migrateProject({ schemaVersion: 1, id: 'x1', tracks: [{ type: 'video', clips: [] }] });
    expect(p.name).toBe('Untitled');
    expect(p.settings).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    expect(p.tracks.some((t) => t.kind === 'audio')).toBe(true);
    const q = migrateProject({ schemaVersion: 1, id: 'x2', tracks: [] });
    expect(q.tracks.map((t) => t.kind).sort()).toEqual(['audio', 'video']);
  });

  it('rejects newer schema versions and garbage', () => {
    expect(() => migrateProject({ ...richProject(), schemaVersion: SCHEMA_VERSION + 1 })).toThrow(/newer/);
    for (const bad of [null, undefined, 42, 'project', [], {}, { schemaVersion: 0 }, { schemaVersion: 'two' }, { schemaVersion: 1.5 }]) {
      expect(() => migrateProject(bad)).toThrow(MigrationError);
    }
    // Valid version but invalid content.
    expect(() => migrateProject({ schemaVersion: 2, id: 'x', name: 'n', settings: { width: 1, height: 1, fps: 30 }, tracks: [] })).toThrow(MigrationError);
    // v1 document with an illegal clip (audio clip on video track) is rejected, not silently accepted.
    expect(() =>
      migrateProject({ schemaVersion: 1, id: 'x', tracks: [{ type: 'video', clips: [{ id: 'a', kind: 'audio', assetId: 'm', timelineStartUs: 0, durationUs: S }] }] }),
    ).toThrow(MigrationError);
  });

  it('rejects documents with injected markup in colors or duplicate ids', () => {
    const p = JSON.parse(JSON.stringify(richProject()));
    p.tracks[0].clips[0].style.color = 'red;background:url(x)';
    expect(() => migrateProject(p)).toThrow(MigrationError);
    const q = JSON.parse(JSON.stringify(richProject()));
    q.tracks[1].clips[1].id = 'c1';
    expect(() => migrateProject(q)).toThrow(/duplicate/);
  });
});

describe('command immutability and reversibility', () => {
  const ops: [string, (p: Project) => Project][] = [
    ['addClip', (p) => cmd.addClip(p, { trackId: 'v2', clip: textClip('new', 0, S) }, ctx)],
    ['removeClips', (p) => cmd.removeClips(p, { clipIds: ['c1'] })],
    ['moveClip', (p) => cmd.moveClip(p, { clipId: 'c2', timelineStartUs: 9 * S, trackId: 'v2' })],
    ['trimClip', (p) => cmd.trimClip(p, { clipId: 'c1', startUs: S, endUs: 3 * S }, ctx)],
    ['splitClip', (p) => cmd.splitClip(p, { clipId: 'm1', atUs: 5 * S, newId: 'm2' })],
    ['updateClip', (p) => cmd.updateClip(p, { clipId: 'c2', patch: { transform: { crop: { top: 0.3 } } } }, ctx)],
    ['duplicateClip', (p) => cmd.duplicateClip(p, { clipId: 'c2', newId: 'dd' })],
    ['pasteClips', (p) => cmd.pasteClips(p, { clips: [{ trackId: 'v1', clip: getClip(p, 'c1') }], atUs: 30 * S }, ctx)],
    ['setTransition', (p) => cmd.setTransition(p, { clipId: 'c2', transition: null })],
    ['rippleDelete', (p) => cmd.rippleDelete(p, { clipId: 'c1' })],
    ['addTrack', (p) => cmd.addTrack(p, { kind: 'audio', id: 'a9' })],
    ['removeTrack', (p) => cmd.removeTrack(p, { trackId: 'a2' })],
    ['updateTrack', (p) => cmd.updateTrack(p, { trackId: 'v1', patch: { hidden: true } })],
    ['reorderTrack', (p) => cmd.reorderTrack(p, { trackId: 'v1', direction: -1 })],
    ['updateSettings', (p) => cmd.updateSettings(p, { patch: {}, aspect: '1:1' })],
    ['renameProject', (p) => cmd.renameProject(p, { name: 'Renamed' })],
    ['setCaptions', (p) => cmd.setCaptions(p, { segments: [] })],
    ['updateCaption', (p) => cmd.updateCaption(p, { id: 'cap1', patch: { text: 'edited' } })],
    ['removeCaption', (p) => cmd.removeCaption(p, { id: 'cap1' })],
    ['addCaption', (p) => cmd.addCaption(p, { startUs: 2 * S, endUs: 3 * S, text: 'more' })],
    ['updateCaptionSettings', (p) => cmd.updateCaptionSettings(p, { patch: { enabled: false } })],
    ['duckUnderCaptions', (p) => cmd.duckUnderCaptions(p, { clipId: 'm1', duckGain: 0.2 })],
  ];

  it.each(ops)('%s never mutates its (deep-frozen) input and restoring the snapshot is exact', (_name, op) => {
    const original = richProject();
    const snapshot = structuredClone(original);
    const frozen = deepFreeze(structuredClone(original));
    const next = op(frozen);
    expect(next).not.toBe(frozen);
    expect(next).not.toEqual(snapshot); // the edit did something
    expect(frozen).toEqual(snapshot); // input untouched
    expect(ProjectSchema.parse(next)).toEqual(next);
    // The output shares no mutable references with the input: mutating it leaves the snapshot intact.
    for (const t of next.tracks) for (const c of t.clips) c.timelineStartUs += 1;
    next.captions.segments.length = 0;
    expect(frozen).toEqual(snapshot);
    // Undo = restore the snapshot taken before the command.
    expect(ProjectSchema.parse(snapshot)).toEqual(original);
  });
});

describe('editor store undo/redo (snapshot based)', () => {
  const dto = (id: string): AssetDTO => {
    const a = assets[id];
    return {
      id,
      name: a.name,
      kind: a.kind,
      mimeType: 'application/octet-stream',
      sizeBytes: 1,
      status: 'ready',
      metadata: { durationUs: a.durationUs, width: a.width, height: a.height, hasAudio: a.hasAudio },
      createdAt: '2026-01-01T00:00:00Z',
    } as AssetDTO;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    useEditor.setState({ project: richProject(), past: [], future: [], toasts: [], assets: Object.keys(assets).map(dto), saveState: 'saved' });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('edit → undo → redo restores exact snapshots', () => {
    const s = useEditor.getState();
    const p0 = s.project!;
    const p0Json = JSON.stringify(p0);
    expect(s.edit('Split', (p) => cmd.splitClip(p, { clipId: 'c1', atUs: 2 * S, newId: 'c1b' }))).toBe(true);
    const p1 = useEditor.getState().project!;
    expect(useEditor.getState().edit('Trim', (p, c) => cmd.trimClip(p, { clipId: 'c1b', endUs: 3 * S }, c))).toBe(true);
    const p2 = useEditor.getState().project!;
    expect(useEditor.getState().saveState).toBe('dirty');
    expect(useEditor.getState().past.map((h) => h.label)).toEqual(['Split', 'Trim']);

    useEditor.getState().undo();
    expect(useEditor.getState().project).toBe(p1);
    useEditor.getState().undo();
    expect(useEditor.getState().project).toBe(p0);
    expect(JSON.stringify(useEditor.getState().project)).toBe(p0Json);
    useEditor.getState().undo(); // nothing left: no-op
    expect(useEditor.getState().project).toBe(p0);

    useEditor.getState().redo();
    expect(useEditor.getState().project).toBe(p1);
    useEditor.getState().redo();
    expect(useEditor.getState().project).toBe(p2);
    expect(useEditor.getState().future).toHaveLength(0);
    useEditor.getState().redo(); // nothing left: no-op
    expect(useEditor.getState().project).toBe(p2);
  });

  it('a new edit after undo clears the redo stack', () => {
    const st = useEditor.getState;
    st().edit('Move', (p) => cmd.moveClip(p, { clipId: 'c2', timelineStartUs: 10 * S }));
    st().undo();
    expect(st().future).toHaveLength(1);
    st().edit('Rename', (p) => cmd.renameProject(p, { name: 'X' }));
    expect(st().future).toHaveLength(0);
    expect(st().past.map((h) => h.label)).toEqual(['Rename']);
  });

  it('failed edits do not change the project or history and surface an error toast', () => {
    const st = useEditor.getState;
    const before = st().project;
    expect(st().edit('Bad split', (p) => cmd.splitClip(p, { clipId: 'c1', atUs: 0 }))).toBe(false);
    expect(st().project).toBe(before);
    expect(st().past).toHaveLength(0);
    expect(st().toasts.at(-1)).toMatchObject({ kind: 'error' });
    expect(st().toasts.at(-1)!.text).toMatch(/Bad split failed/);
  });

  it('no-op edits (command returns same project) are not recorded', () => {
    const st = useEditor.getState;
    expect(st().edit('Reorder', (p) => cmd.reorderTrack(p, { trackId: 'v1', direction: 1 }))).toBe(false);
    expect(st().past).toHaveLength(0);
  });

  it('edits use the asset index from the store (source-length limits enforced)', () => {
    const st = useEditor.getState;
    expect(st().edit('Trim long', (p, c) => cmd.trimClip(p, { clipId: 'c2', endUs: 100 * S }, c))).toBe(true);
    expect(getClip(st().project!, 'c2').durationUs).toBe(10 * S);
  });
});
