# FrameForge API (Worker)

Source of truth for endpoints and DTOs: `src/shared/api-types.ts`. Implementation: `src/worker/`.
This page documents behaviour that the type file does not.

## Conventions

- All routes are under `/api`, JSON unless noted. Every response carries `X-Request-Id`.
- Errors: `{ "error": { "code", "message", "requestId" } }`. Some errors add top-level fields
  (`current` on 409 `conflict`, `operationId` on AI failures, `retryAfterSec` on 429).
- **CSRF**: every `POST/PUT/PATCH/DELETE` must send `X-FF-Client: 1` (or `Content-Type: application/json`), else 403 `csrf_rejected`.
- **Auth**: cookie `ff_session` (HttpOnly, SameSite=Lax, Path=/, 30 days sliding; `Secure` except on `http://localhost`).
  Only the SHA-256 of the token is stored. Unauthenticated access to user routes → 401 `unauthorized`.
- **Ownership**: every project/asset/export/AI route queries `WHERE id=? AND owner_id=?`; other users' ids return **404**.
- JSON request bodies are limited to ~2.25 MB (413 `too_large`).

| Status / code | Meaning |
|---|---|
| 400 `invalid_input` / `invalid_json` | zod validation failed (message lists fields) / unparsable body |
| 401 `unauthorized`, `invalid_credentials` | no session / login failed ("Invalid email or password") |
| 403 `forbidden`, `csrf_rejected`, `limit_reached` | not admin / missing client header / project count limit |
| 404 `not_found` | missing or not owned |
| 409 `conflict`, `invalid_transition`, `not_ready`, `already_uploaded`, `registration_failed` | see below |
| 411 `length_required` | uploads need `Content-Length` |
| 413 `too_large`, `quota_exceeded` | size or storage quota |
| 415 `unsupported_media_type`, `invalid_media` | MIME not allowed / magic bytes don't match |
| 416 `range_not_satisfiable` | bad Range |
| 429 `rate_limited` | with `Retry-After` |
| 502/504 `ai_provider_error`, 502 `ai_invalid_output`, 503 `ai_not_configured` | OpenAI issues |

## Auth

- Password: 8–200 chars; email normalised to lowercase. Hash: PBKDF2-SHA256, 100 000 iterations, 16-byte salt (`pbkdf2$100000$salt$hash`).
- `POST /auth/guest` returns the current user if already signed in. `POST /auth/register` while a guest upgrades that user in place (same id, projects kept). Sessions are rotated on register/login.
- Duplicate email on register → 409 `registration_failed` (generic message).
- Rate limits (fixed window, D1 `rate_limits`): login 10 / 15 min per IP+email; register 20 / h per IP; guest creation 60 / h per IP.
- `isAdmin`: email in `ADMIN_EMAILS` (comma-separated, case-insensitive) and not a guest.

## Projects

- `PUT /projects/:id {data, baseVersion}`: `baseVersion` must equal the current version, else **409** `conflict` with `current: ProjectDTO`. `data` must pass `ProjectSchema` (schema v2), `data.id` must equal `:id`, serialized ≤ 2 MB. Returns the new summary (`version` = baseVersion + 1). Stored data has zod defaults filled in.
- `GET` returns data migrated via `migrateProject`. `PATCH {name}` renames the row and `data.name` (new version).
- Revisions: a snapshot is stored at create, then on save if ≥ 2 min since the last snapshot or ≥ 20 versions later, and always on restore. Last 30 kept. `POST /revisions/:version/restore` writes the snapshot as a new version.
- Max 200 projects per user (403 `limit_reached`). `durationUs` = end of last clip; `thumbnailAssetId` = asset of the earliest video/image clip.
- Deleting a project deletes its revisions, exports and export files.

## Assets

- Allowed: `video/mp4`, `image/png`, `image/jpeg`, `audio/mpeg` (`audio/mp3`), `audio/wav` (`audio/x-wav`, `audio/wave`). `kind` must match the MIME type.
- `POST /assets`: `sizeBytes` ≤ 100 MB; declared `metadata.durationUs` ≤ 20 min; quota = sum of non-failed assets + new size ≤ 2 GB (registered) / 500 MB (guest), else 413 `quota_exceeded`. Pending uploads count toward the quota; those not finished within 24 h are removed by the cron.
- `PUT /assets/:id/content`: raw body; `Content-Length` must equal the declared `sizeBytes`; `Content-Type` must be a MIME of the same kind. The body is **streamed** into R2. Only the first 12 bytes are buffered for magic-byte checks (MP4 `ftyp`@4, PNG, JPEG, MP3 `ID3`/frame sync, WAV `RIFF…WAVE`). On mismatch → 415 `invalid_media` and the asset becomes `failed`. Uploading again after `failed` is allowed; after `ready` it returns 409.
- `GET /assets/:id/content`: single `Range` supported (206 + `Content-Range`), `Cache-Control: private`. Not `ready` → 409 `not_ready`.
- `PATCH /assets/:id {name?, metadata?}`: metadata is **merged** into the stored metadata, then validated (peaks ≤ 2000 values in 0..1).
- Thumbnails: `image/jpeg|png|webp` ≤ 512 KB; `metadata.hasThumbnail` reflects whether one exists.
- Asset ids used inside project JSON are not cross-checked on save; access to bytes is always owner-checked.

## Exports

- Rendering happens in the browser. Server state machine: `queued → running → (running…) → completed | failed | canceled`; `queued → failed | canceled`. Terminal states never change; retry = new export. Invalid moves → 409 `invalid_transition`.
- `PATCH {status, progress?, error?}`: `progress` is a **fraction 0..1**.
- `PUT /exports/:id/file`: only when `running`; raw MP4 ≤ 100 MB with `ftyp`; sets `completed`, `progress=1`, `sizeBytes`. A non-MP4 body → 415 and the status is unchanged.
- `GET /exports/:id/download`: `Content-Disposition: attachment; filename="<project name> <height>p.mp4"` (ASCII-sanitized), Range supported.
- Limit: 30 exports created per user per hour.

## AI (OpenAI, server-side only)

- `POST /ai/transcribe` (multipart `file`, `projectId`, `assetId`, `offsetSec`): file `audio/wav` or `audio/mpeg` ≤ 24 MB, magic bytes checked; project and asset must be owned. Forwarded to `/v1/audio/transcriptions` with `OPENAI_TRANSCRIPTION_MODEL` (default `whisper-1`), `verbose_json`, segment + word timestamps. `offsetSec` is added to every timestamp. For non-`whisper-1` models only `json` is requested and a single segment spanning the audio is returned (no word timing).
- `POST /ai/plan {projectId, instruction≤2000}`: sends `describeProjectForAi(project)` + instruction to `/v1/chat/completions` (`OPENAI_MODEL`, default `gpt-4o-mini`, temperature 0.2, strict `json_schema`). Output is validated with `AiPlanSchema`; operations referencing unknown clip/track ids are dropped and noted in `unsupported`. Model refusals produce an empty plan with the refusal in `unsupported`.
- Timeout 120 s per attempt; one retry on 429/5xx/network error.
- Every call is recorded in `ai_operations` (status, latency, tokens, audio seconds, estimated cost; never prompts or transcripts). Pricing table: `src/worker/lib/pricing.ts`.
- Limit: 60 AI calls per user per rolling hour (429). Without `OPENAI_API_KEY` → 503 `ai_not_configured` (input validation and ownership are checked first).
- Data sent to OpenAI: extracted audio (transcribe) and a text description of the timeline incl. clip/asset names, text overlays and up to 20 caption lines (plan).

## Ops

- `GET /health`: `{ok, version, time, checks:{database, storage}, openaiConfigured, models}`. Always 200; `ok=false` if a check fails.
- `GET /admin/metrics?range=1h|24h|3d|7d` (default 24h): admin only (403). Aggregates only.
- Logs: one JSON line per request `{level,msg,requestId,method,path,status,ms,userId?}`; no bodies, tokens or passwords.
- Cron `17 3 * * *` (`scheduled`): deletes guests inactive > 7 days (rows + all R2 objects under `u/<id>/`), expired sessions, pending/failed assets older than 24 h, marks exports stuck in queued/running > 24 h as failed, prunes old rate-limit rows.

## Storage layout (R2, private)

`u/<ownerId>/a/<assetId>/original`, `u/<ownerId>/a/<assetId>/thumb`, `u/<ownerId>/e/<exportId>.mp4`. Keys are built from server-generated ids only. All access goes through `src/worker/storage.ts`.

## Local development

```bash
npx wrangler d1 migrations apply DB --local -c wrangler.jsonc   # -c needed: .wrangler/deploy/config.json points wrangler at dist/
npx vite dev --port 5173                                       # worker in workerd, local D1/R2 in .wrangler/state/v3
npx vitest run                                                  # unit tests (tests/unit)
npx playwright test --project=api                               # API tests; SKIP_REAL_AI=1 skips the 2 real OpenAI calls
```

Test `CF-Connecting-IP` headers are honoured locally so IP-keyed rate limits can be isolated per test run; on Cloudflare the edge sets this header.
