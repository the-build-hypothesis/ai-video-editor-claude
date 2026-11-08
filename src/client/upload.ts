import { api, ApiError, uploadWithProgress } from './api';
import { probeFile, ProbeError } from './engine/probe';
import { mediaCache } from './engine/media-cache';
import { useEditor, type UploadItem } from './store';
import { LIMITS, type AssetDTO } from '../shared/api-types';

function patchUpload(id: string, patch: Partial<UploadItem>) {
  useEditor.setState((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, ...patch } : u)) }));
}

export async function uploadFiles(files: File[]): Promise<AssetDTO[]> {
  const done: AssetDTO[] = [];
  // Bulk import (MEDIA-09): sequential to bound memory; each item has its own status.
  const items: UploadItem[] = files.map((f) => ({ id: Math.random().toString(36).slice(2), name: f.name, progress: 0, status: 'probing', file: f }));
  useEditor.setState((s) => ({ uploads: [...s.uploads, ...items] }));
  for (const item of items) {
    const a = await runUpload(item);
    if (a) done.push(a);
  }
  return done;
}

export function retryUpload(id: string) {
  const item = useEditor.getState().uploads.find((u) => u.id === id);
  if (item) void runUpload({ ...item, status: 'probing', progress: 0, error: undefined });
}

export function cancelUpload(id: string) {
  const item = useEditor.getState().uploads.find((u) => u.id === id);
  item?.abort?.abort();
  useEditor.setState((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) }));
}

export function dismissUpload(id: string) {
  useEditor.setState((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) }));
}

async function runUpload(item: UploadItem): Promise<AssetDTO | null> {
  const st = useEditor.getState();
  const abort = new AbortController();
  patchUpload(item.id, { status: 'probing', progress: 0, error: undefined, abort });
  let assetId: string | null = null;
  try {
    const probe = await probeFile(item.file);
    if (abort.signal.aborted) return null;
    const { asset } = await api.createAsset({ name: item.file.name.slice(0, 200), kind: probe.kind, mimeType: probe.mimeType, sizeBytes: item.file.size, metadata: probe.metadata });
    assetId = asset.id;
    patchUpload(item.id, { status: 'uploading' });
    const res = item.file.size > LIMITS.singleUploadMaxBytes
      ? await multipartUpload(asset.id, item.file, probe.mimeType, (f) => patchUpload(item.id, { progress: f }), abort.signal)
      : ((await uploadWithProgress(`/api/assets/${asset.id}/content`, item.file, probe.mimeType, (f) => patchUpload(item.id, { progress: f }), abort.signal)) as { asset: AssetDTO });
    mediaCache.putBlob(asset.id, item.file);
    if (probe.thumbnail) await api.putThumbnail(asset.id, probe.thumbnail).catch(() => {});
    patchUpload(item.id, { status: 'done', progress: 1 });
    setTimeout(() => dismissUpload(item.id), 1500);
    await st.refreshAssets();
    return res.asset ?? asset;
  } catch (e) {
    const canceled = e instanceof ApiError && e.code === 'canceled';
    if (assetId) await api.deleteAsset(assetId).catch(() => {}); // remove the pending record; nothing references it yet
    if (canceled) {
      dismissUpload(item.id);
      return null;
    }
    const msg = e instanceof ProbeError || e instanceof ApiError ? e.message : `Unexpected error: ${(e as Error).message}`;
    patchUpload(item.id, { status: 'error', error: msg });
    st.toast('error', `Upload of "${item.name}" failed: ${msg}`);
    await st.refreshAssets();
    return null;
  }
}

/** Large files (> 90 MB): sequential 64 MB parts, each retried up to 3 times; aggregate progress. */
async function multipartUpload(assetId: string, file: File, mime: string, onProgress: (f: number) => void, signal: AbortSignal): Promise<{ asset: AssetDTO }> {
  const begin = await fetch(`/api/assets/${assetId}/multipart`, { method: 'POST', headers: { 'X-FF-Client': '1' }, credentials: 'same-origin' });
  if (!begin.ok) throw new ApiError(begin.status, 'upload_failed', ((await begin.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? 'Could not start upload');
  const { partSize, partCount } = (await begin.json()) as { partSize: number; partCount: number };
  for (let n = 1; n <= partCount; n++) {
    const blob = file.slice((n - 1) * partSize, Math.min(file.size, n * partSize));
    for (let attempt = 1; ; attempt++) {
      try {
        await uploadWithProgress(`/api/assets/${assetId}/multipart/${n}`, blob, mime, (f) => onProgress(((n - 1) * partSize + f * blob.size) / file.size), signal);
        break;
      } catch (e) {
        if (signal.aborted || (e instanceof ApiError && (e.code === 'canceled' || e.status === 415 || e.status === 507)) || attempt >= 3) throw e;
      }
    }
  }
  const done = await fetch(`/api/assets/${assetId}/multipart/complete`, { method: 'POST', headers: { 'X-FF-Client': '1' }, credentials: 'same-origin' });
  const body = (await done.json().catch(() => null)) as { asset?: AssetDTO; error?: { message?: string } } | null;
  if (!done.ok || !body?.asset) throw new ApiError(done.status, 'upload_failed', body?.error?.message ?? 'Could not finalize upload');
  return { asset: body.asset };
}
