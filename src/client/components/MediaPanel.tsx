import { useRef, useState } from 'react';
import { useEditor } from '../store';
import { assetThumbUrl, api } from '../api';
import { Icon, confirmDialog, formatBytes } from './ui';
import { uploadFiles, retryUpload, cancelUpload, dismissUpload } from '../upload';
import { addAssetToTimeline, addTextPreset } from '../actions';
import { formatShort } from '../../shared/time';
import { LIMITS, type AssetDTO } from '../../shared/api-types';

export const ASSET_DRAG_TYPE = 'application/x-frameforge-asset';

export function MediaPanel() {
  const [tab, setTab] = useState<'media' | 'text'>('media');
  return (
    <div className="media-panel">
      <div className="tabs" role="tablist" aria-label="Library">
        <button role="tab" aria-selected={tab === 'media'} className={tab === 'media' ? 'active' : ''} onClick={() => setTab('media')}>
          <Icon name="film" size={14} /> Media
        </button>
        <button role="tab" aria-selected={tab === 'text'} className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')} data-testid="text-tab">
          <Icon name="text" size={14} /> Text
        </button>
      </div>
      {tab === 'media' ? <MediaList /> : <TextPresets />}
    </div>
  );
}

function TextPresets() {
  const items: [Parameters<typeof addTextPreset>[0], string, string][] = [
    ['title', 'Title', 'Large centered heading with fade'],
    ['lowerThird', 'Lower third', 'Name and role, slides up'],
    ['subtitle', 'Subtitle', 'Boxed text near the bottom'],
    ['text', 'Plain text', 'Simple text overlay'],
  ];
  return (
    <div className="text-presets">
      <p className="muted small">Text is added at the playhead on the top visual track. Edit it in the Inspector.</p>
      {items.map(([k, label, desc]) => (
        <button key={k} className={`preset preset-${k}`} onClick={() => addTextPreset(k)} data-testid={`add-${k}`}>
          <span className="preset-name">{label}</span>
          <span className="muted small">{desc}</span>
        </button>
      ))}
    </div>
  );
}

function MediaList() {
  const assets = useEditor((s) => s.assets);
  const uploads = useEditor((s) => s.uploads);
  const storage = useEditor((s) => s.storage);
  const project = useEditor((s) => s.project);
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const used = new Set(project?.tracks.flatMap((t) => t.clips.map((c) => (c.kind === 'text' ? '' : c.assetId))) ?? []);

  const onFiles = (files: FileList | null) => {
    if (files && files.length) void uploadFiles(Array.from(files));
  };

  const del = async (a: AssetDTO) => {
    const inUse = used.has(a.id);
    const ok = await confirmDialog({
      title: `Delete "${a.name}"?`,
      message: inUse ? 'This media is used in the current project (and possibly others). Clips using it will show as missing. This cannot be undone.' : 'This permanently deletes the file from your library.',
      confirmLabel: 'Delete media',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteAsset(a.id);
      await useEditor.getState().refreshAssets();
    } catch (e) {
      useEditor.getState().toast('error', (e as Error).message);
    }
  };

  return (
    <div
      className={`media-list-wrap ${drag ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        onFiles(e.dataTransfer.files);
      }}
    >
      <div className="media-actions">
        <button className="btn btn-primary btn-block" onClick={() => inputRef.current?.click()} data-testid="import-media">
          <Icon name="upload" /> Import media
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          accept="video/mp4,.mp4,.m4v,image/png,image/jpeg,.png,.jpg,.jpeg,audio/mpeg,.mp3,audio/wav,.wav"
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = '';
          }}
          data-testid="file-input"
        />
        <p className="hint">
          MP4 (H.264), PNG/JPEG, MP3/WAV · max {LIMITS.maxAssetBytes / 1048576} MB per file · drag files here
        </p>
      </div>
      {uploads.length > 0 && (
        <ul className="upload-list" aria-label="Uploads">
          {uploads.map((u) => (
            <li key={u.id} className={`upload upload-${u.status}`}>
              <div className="upload-name">{u.name}</div>
              {u.status === 'error' ? (
                <div className="upload-error" role="alert">
                  {u.error}
                </div>
              ) : (
                <div className="progress" role="progressbar" aria-label={`Uploading ${u.name}`} aria-valuenow={Math.round(u.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div style={{ width: `${u.status === 'probing' ? 3 : Math.round(u.progress * 100)}%` }} />
                </div>
              )}
              <div className="upload-actions">
                <span className="muted small">{u.status === 'probing' ? 'Checking file…' : u.status === 'uploading' ? `${Math.round(u.progress * 100)}%` : u.status === 'done' ? 'Done' : ''}</span>
                {u.status === 'error' && (
                  <>
                    <button className="btn btn-sm" onClick={() => retryUpload(u.id)}>
                      Retry
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => dismissUpload(u.id)}>
                      Dismiss
                    </button>
                  </>
                )}
                {(u.status === 'uploading' || u.status === 'probing') && (
                  <button className="btn btn-sm btn-ghost" onClick={() => cancelUpload(u.id)}>
                    Cancel
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {assets.length === 0 && uploads.length === 0 && (
        <div className="empty small-empty">
          <Icon name="upload" size={28} />
          <p>No media yet. Import video, images or audio to start editing.</p>
        </div>
      )}
      <ul className="asset-list" aria-label="Media library">
        {assets.map((a) => (
          <li
            key={a.id}
            className={`asset asset-${a.status}`}
            draggable={a.status === 'ready'}
            onDragStart={(e) => {
              e.dataTransfer.setData(ASSET_DRAG_TYPE, a.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onDoubleClick={() => addAssetToTimeline(a)}
            data-testid="asset"
            data-asset-name={a.name}
          >
            <div className="asset-thumb">
              {a.metadata.hasThumbnail ? <img src={assetThumbUrl(a.id)} alt="" loading="lazy" /> : <Icon name={a.kind === 'audio' ? 'music' : a.kind === 'image' ? 'image' : 'film'} size={22} />}
              {a.kind !== 'image' && a.metadata.durationUs !== null && <span className="asset-dur">{formatShort(a.metadata.durationUs)}</span>}
            </div>
            <div className="asset-info">
              <div className="asset-name" title={a.name}>
                {a.name}
              </div>
              <div className="muted small">
                {a.kind}
                {a.metadata.width ? ` · ${a.metadata.width}×${a.metadata.height}` : ''}
                {a.kind === 'video' ? (a.metadata.hasAudio ? ' · audio' : ' · no audio') : ''} · {formatBytes(a.sizeBytes)}
                {a.status !== 'ready' && <span className="pill pill-warn">{a.status}</span>}
                {used.has(a.id) && <span className="pill">in use</span>}
              </div>
            </div>
            <div className="asset-btns">
              <button className="icon-btn" aria-label={`Add ${a.name} to timeline`} title="Add to timeline at end of track" onClick={() => addAssetToTimeline(a)} disabled={a.status !== 'ready'} data-testid="add-asset">
                <Icon name="plus" />
              </button>
              <button className="icon-btn danger" aria-label={`Delete ${a.name}`} title="Delete from library" onClick={() => del(a)}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      {storage && (
        <div className="storage muted small">
          Storage: {formatBytes(storage.bytes)} of {formatBytes(storage.limitBytes)}
          <div className="progress thin">
            <div style={{ width: `${Math.min(100, (storage.bytes / storage.limitBytes) * 100)}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
