import type {
  AdminMetricsDTO,
  AiOperationDTO,
  AssetDTO,
  AssetMetadata,
  ExportDTO,
  HealthDTO,
  ProjectDTO,
  ProjectSummaryDTO,
  UserDTO,
} from '../shared/api-types';
import type { AiPlan } from '../shared/ai-actions';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'X-FF-Client': '1' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData || body instanceof Blob) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, 'network', 'Network error — check your connection and try again.');
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; requestId?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'http_' + res.status, err?.message ?? `Request failed (${res.status})`, err?.requestId ?? res.headers.get('X-Request-Id') ?? undefined, json);
  }
  return json as T;
}

export const api = {
  health: () => request<HealthDTO>('GET', '/api/health'),
  me: () => request<{ user: UserDTO | null }>('GET', '/api/auth/me'),
  guest: () => request<{ user: UserDTO }>('POST', '/api/auth/guest', {}),
  register: (email: string, password: string) => request<{ user: UserDTO }>('POST', '/api/auth/register', { email, password }),
  login: (email: string, password: string) => request<{ user: UserDTO }>('POST', '/api/auth/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout', {}),

  listProjects: () => request<{ projects: ProjectSummaryDTO[] }>('GET', '/api/projects'),
  createProject: (name: string, aspect: string, fps: number) => request<{ project: ProjectDTO }>('POST', '/api/projects', { name, aspect, fps }),
  getProject: (id: string) => request<{ project: ProjectDTO }>('GET', `/api/projects/${encodeURIComponent(id)}`),
  saveProject: (id: string, data: unknown, baseVersion: number) =>
    request<{ project: ProjectSummaryDTO }>('PUT', `/api/projects/${encodeURIComponent(id)}`, { data, baseVersion }),
  renameProject: (id: string, name: string) => request<{ project: ProjectSummaryDTO }>('PATCH', `/api/projects/${encodeURIComponent(id)}`, { name }),
  deleteProject: (id: string) => request<{ ok: true }>('DELETE', `/api/projects/${encodeURIComponent(id)}`),
  duplicateProject: (id: string) => request<{ project: ProjectSummaryDTO }>('POST', `/api/projects/${encodeURIComponent(id)}/duplicate`, {}),
  revisions: (id: string) => request<{ revisions: { version: number; createdAt: string }[] }>('GET', `/api/projects/${encodeURIComponent(id)}/revisions`),
  restoreRevision: (id: string, version: number) => request<{ project: ProjectDTO }>('POST', `/api/projects/${encodeURIComponent(id)}/revisions/${version}/restore`, {}),

  listAssets: () => request<{ assets: AssetDTO[]; usage: { bytes: number; limitBytes: number } }>('GET', '/api/assets'),
  createAsset: (a: { name: string; kind: string; mimeType: string; sizeBytes: number; metadata: AssetMetadata }) => request<{ asset: AssetDTO }>('POST', '/api/assets', a),
  patchAsset: (id: string, patch: { metadata?: AssetMetadata; name?: string }) => request<{ asset: AssetDTO }>('PATCH', `/api/assets/${encodeURIComponent(id)}`, patch),
  deleteAsset: (id: string) => request<{ ok: true }>('DELETE', `/api/assets/${encodeURIComponent(id)}`),
  putThumbnail: (id: string, blob: Blob) =>
    request<{ ok: true }>('PUT', `/api/assets/${encodeURIComponent(id)}/thumbnail`, undefined, { body: blob, headers: { 'X-FF-Client': '1', 'Content-Type': blob.type } }),

  transcribe: (form: FormData) =>
    request<{ segments: { startSec: number; endSec: number; text: string }[]; words: { startSec: number; endSec: number; word: string }[]; language: string; durationSec: number; operationId: string }>(
      'POST',
      '/api/ai/transcribe',
      form,
    ),
  plan: (projectId: string, instruction: string) => request<{ plan: AiPlan; operationId: string; latencyMs?: number }>('POST', '/api/ai/plan', { projectId, instruction }),
  aiOperations: (projectId: string) => request<{ operations: AiOperationDTO[] }>('GET', `/api/ai/operations?projectId=${encodeURIComponent(projectId)}`),

  createExport: (b: { projectId: string; preset: string; width: number; height: number; fps: number; durationUs: number }) => request<{ export: ExportDTO }>('POST', '/api/exports', b),
  patchExport: (id: string, b: { status: string; progress?: number; error?: string }) => request<{ export: ExportDTO }>('PATCH', `/api/exports/${encodeURIComponent(id)}`, b),
  listExports: (projectId: string) => request<{ exports: ExportDTO[] }>('GET', `/api/exports?projectId=${encodeURIComponent(projectId)}`),
  deleteExport: (id: string) => request<{ ok: true }>('DELETE', `/api/exports/${encodeURIComponent(id)}`),
  adminMetrics: (range: string) => request<AdminMetricsDTO>('GET', `/api/admin/metrics?range=${encodeURIComponent(range)}`),
};

export const assetContentUrl = (id: string) => `/api/assets/${encodeURIComponent(id)}/content`;
export const assetThumbUrl = (id: string) => `/api/assets/${encodeURIComponent(id)}/thumbnail`;
export const exportDownloadUrl = (id: string) => `/api/exports/${encodeURIComponent(id)}/download`;

/** Upload raw bytes with progress + cancellation (XHR, since fetch lacks upload progress). */
export function uploadWithProgress(
  url: string,
  body: Blob,
  contentType: string,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.setRequestHeader('X-FF-Client', '1');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let json: unknown = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(json);
      else {
        const err = (json as { error?: { code?: string; message?: string; requestId?: string } } | null)?.error;
        reject(new ApiError(xhr.status, err?.code ?? 'upload_failed', err?.message ?? `Upload failed (${xhr.status})`, err?.requestId));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Network error during upload — retry when your connection is back.'));
    xhr.onabort = () => reject(new ApiError(0, 'canceled', 'Upload canceled'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(body);
  });
}
