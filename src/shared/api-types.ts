/**
 * HTTP API contract shared by the Worker and the browser client. All endpoints are under /api,
 * JSON unless noted, cookie-session authenticated (cookie `ff_session`, HttpOnly, Secure, SameSite=Lax).
 * Errors: { error: { code: string, message: string, requestId: string } } with appropriate status.
 * Every response carries header X-Request-Id.
 *
 * AUTH
 *  GET    /api/auth/me                         -> { user: UserDTO | null }
 *  POST   /api/auth/guest                      -> { user }   (creates guest user + session if none)
 *  POST   /api/auth/register {email,password}  -> { user }   (if current session is a guest, upgrades it and keeps projects)
 *  POST   /api/auth/login {email,password}     -> { user }   (rate limited: 10 / 15 min per IP+email)
 *  POST   /api/auth/logout                     -> { ok: true }
 *
 * PROJECTS (owner-scoped; other users' ids return 404)
 *  GET    /api/projects                        -> { projects: ProjectSummaryDTO[] }
 *  POST   /api/projects {name, aspect?, fps?}  -> { project: ProjectDTO }
 *  GET    /api/projects/:id                    -> { project: ProjectDTO }   (data migrated to current schema)
 *  PUT    /api/projects/:id {data, baseVersion}-> { project: ProjectSummaryDTO } | 409 {error.code='conflict', current: ProjectDTO}
 *  PATCH  /api/projects/:id {name}             -> { project: ProjectSummaryDTO }   (also renames inside data)
 *  DELETE /api/projects/:id                    -> { ok: true }
 *  POST   /api/projects/:id/duplicate          -> { project: ProjectSummaryDTO }
 *  GET    /api/projects/:id/revisions          -> { revisions: {version, createdAt}[] }
 *  POST   /api/projects/:id/revisions/:version/restore -> { project: ProjectDTO }
 *
 * ASSETS (user library, reusable across that user's projects)
 *  GET    /api/assets                          -> { assets: AssetDTO[], usage: {bytes, limitBytes} }
 *  POST   /api/assets {name, kind, mimeType, sizeBytes, metadata} -> { asset }  (status 'pending'; quota checked)
 *  PUT    /api/assets/:id/content  (raw body = file bytes, Content-Type = mimeType) -> { asset } (status 'ready'); ≤ 90 MB
 *  POST   /api/assets/:id/multipart              -> { partSize, partCount }   (files > 90 MB)
 *  PUT    /api/assets/:id/multipart/:partNumber  (raw body, 1-based, exact part size) -> { partNumber }
 *  POST   /api/assets/:id/multipart/complete     -> { asset } (status 'ready')
 *         Server checks size limit and magic bytes for the declared kind.
 *  GET    /api/assets/:id/content  (supports Range) -> bytes
 *  PUT    /api/assets/:id/thumbnail (image/jpeg|png|webp ≤ 512KB) -> { ok }
 *  GET    /api/assets/:id/thumbnail -> bytes
 *  PATCH  /api/assets/:id {metadata?, name?}  -> { asset }
 *  DELETE /api/assets/:id                      -> { ok }
 *
 * AI
 *  POST   /api/ai/transcribe  multipart: file (audio/wav ≤ 24MB), projectId, assetId, offsetSec (number)
 *         -> { segments: {startSec,endSec,text}[], words: {startSec,endSec,word}[], language, durationSec, operationId }
 *  POST   /api/ai/plan {projectId, instruction} -> { plan: AiPlan, operationId }
 *  GET    /api/ai/operations?projectId=        -> { operations: AiOperationDTO[] }
 *
 * EXPORTS (rendering happens in the browser; server tracks job state and stores the MP4)
 *  POST   /api/exports {projectId, preset, width, height, fps, durationUs} -> { export: ExportDTO } (status 'queued')
 *  PATCH  /api/exports/:id {status:'running'|'failed'|'canceled', progress?, error?} -> { export }
 *  PUT    /api/exports/:id/file  (raw body video/mp4) -> { export } (status 'completed')
 *  GET    /api/exports?projectId=              -> { exports: ExportDTO[] }
 *  GET    /api/exports/:id/download            -> mp4 bytes (Content-Disposition attachment)
 *  DELETE /api/exports/:id                     -> { ok }
 *
 * OPS
 *  GET    /api/health                          -> HealthDTO
 *  GET    /api/admin/metrics?range=1h|24h|3d|7d -> AdminMetricsDTO (admin only: email in ADMIN_EMAILS)
 */

export interface UserDTO {
  id: string;
  email: string | null;
  isGuest: boolean;
  isAdmin: boolean;
  createdAt: string;
}

export interface ProjectSummaryDTO {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  durationUs: number;
  thumbnailAssetId: string | null;
}
export interface ProjectDTO extends ProjectSummaryDTO {
  data: unknown;
}

export type AssetKind = 'video' | 'image' | 'audio';
export type AssetStatus = 'pending' | 'ready' | 'failed';
export interface AssetMetadata {
  durationUs: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  /** Normalised peaks 0..1 for waveform display (≤ 2000 values). */
  peaks?: number[];
  hasThumbnail?: boolean;
  fps?: number | null;
}
export interface AssetDTO {
  id: string;
  name: string;
  kind: AssetKind;
  mimeType: string;
  sizeBytes: number;
  status: AssetStatus;
  metadata: AssetMetadata;
  createdAt: string;
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
export interface ExportDTO {
  id: string;
  projectId: string;
  status: JobStatus;
  progress: number;
  preset: string;
  width: number;
  height: number;
  fps: number;
  durationUs: number;
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiOperationDTO {
  id: string;
  kind: 'transcribe' | 'plan';
  model: string;
  status: 'running' | 'completed' | 'failed';
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  audioSeconds: number | null;
  costUsd: number | null;
  error: string | null;
  createdAt: string;
}

export interface HealthDTO {
  ok: boolean;
  version: string;
  time: string;
  checks: { database: boolean; storage: boolean };
  openaiConfigured: boolean;
  models: { plan: string; transcription: string };
}

export interface AdminMetricsDTO {
  range: string;
  since: string;
  users: { total: number; registered: number; guests: number; newInRange: number };
  projects: { total: number; updatedInRange: number };
  storage: { assetBytes: number; exportBytes: number; assetCount: number; backend: 'r2' | 'd1'; capBytes: number | null; usedBytes: number | null };
  exports: { total: number; inRange: number; completed: number; failed: number };
  ai: { calls: number; failed: number; costUsd: number; transcribeSeconds: number; inputTokens: number; outputTokens: number; byKind: Record<string, number> };
}

export const LIMITS = {
  /** Max media file size. Files above singleUploadMaxBytes use multipart upload (64 MB parts). */
  maxAssetBytes: 1024 * 1024 * 1024,
  /** Workers request-body limit is 100 MB on standard plans; single-request uploads stay below it. */
  singleUploadMaxBytes: 90 * 1024 * 1024,
  uploadPartBytes: 64 * 1024 * 1024,
  maxThumbnailBytes: 512 * 1024,
  maxExportBytes: 100 * 1024 * 1024,
  maxTranscribeBytes: 24 * 1024 * 1024,
  maxMediaDurationSec: 20 * 60,
  userStorageBytes: 2 * 1024 * 1024 * 1024,
  guestStorageBytes: 500 * 1024 * 1024,
  maxProjectsPerUser: 200,
  maxProjectJsonBytes: 2 * 1024 * 1024,
  aiCallsPerHour: 60,
  exportsPerHour: 30,
  guestRetentionDays: 7,
} as const;

export const ALLOWED_MIME: Record<string, AssetKind> = {
  'video/mp4': 'video',
  'image/png': 'image',
  'image/jpeg': 'image',
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/wave': 'audio',
};
