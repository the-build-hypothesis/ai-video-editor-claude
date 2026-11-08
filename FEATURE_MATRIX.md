# Feature matrix

Status values: **implemented**, **partial**, **not implemented**, **blocked**.

The "Evidence" column names the automated test or manual check behind each status:
- **U:** unit tests (`npm test`).
- **A:** API tests (`tests/api/api.spec.ts`).
- **E:** browser e2e tests (`tests/e2e/*.spec.ts`), run locally **and against the deployed URL** unless noted.
- **M:** manual inspection of screenshots or exported files in `artifacts/`.

## 4.1 Application shell

| ID | P | Status | Evidence / notes |
|---|---|---|---|
| APP-01 | P0 | implemented | Dashboard, editor and account menu. E: all specs. Desktop-first layout with a single-column fallback below 860 px. |
| APP-02 | P0 | implemented | Save indicator (saved, unsaved, saving, error with retry, conflict, offline). Upload, AI and export progress and errors. Preview shows "Loading media…" while frames load. E: `waitSaved` and export status. |
| APP-03 | P0 | implemented | Create, rename (dashboard and editor title), open, delete with confirmation dialog. A: project CRUD. E: create and open. |
| APP-04 | P1 | implemented | Shortcuts for play, step, split, delete, undo/redo, copy/paste, duplicate, save, zoom, snap and title; `?` opens the reference. Manual check. |
| APP-05 | P1 | implemented | Dark editor theme; dashboard and auth follow light/dark preference; visible focus rings; contrast checked by eye only (no automated a11y audit). |
| APP-06 | P1 | implemented | Empty states for projects, media library, preview, captions and AI examples. No placeholder controls. |

## 4.2 Authentication and authorization

| ID | P | Status | Evidence / notes |
|---|---|---|---|
| AUTH-01 | P0 | implemented | Email and password; PBKDF2-SHA256 with 100k iterations (the Workers maximum); HttpOnly SameSite=Lax Secure session cookie; only the token hash is stored. A: auth tests. E: `account.spec`. |
| AUTH-02 | P0 | implemented | Every project, asset, export and AI route checks `owner_id`; other users get 404. A: cross-user isolation. E: second user blocked in `account.spec`. |
| AUTH-03 | P0 | implemented | "Continue as guest". Registering keeps the guest's projects. A: guest upgrade. E: `edit-export`, `ai-captions`. |
| AUTH-04 | P1 | **blocked** | No transactional email provider or credentials (`EMAIL_FROM` is set, but there's no sending service or key). Not implemented, and no fake reset UI is shown. |
| AUTH-05 | P1 | implemented | Login limited to 10 per 15 min per IP+email; registration per IP; generic error messages. A: rate-limit test (local and production). |

## 4.3 Media

| ID | P | Status | Evidence / notes |
|---|---|---|---|
| MEDIA-01 | P0 | implemented | MP4, PNG, JPEG, MP3, WAV. E: all fixture types uploaded. |
| MEDIA-02 | P0 | implemented | Name, type, duration, dimensions, audio presence, size and status in the library. |
| MEDIA-03 | P0 | implemented | "+" button appends to the right track; double-click; drag to a timeline track. |
| MEDIA-04 | P0 | implemented | Client probe decodes before upload; server checks magic bytes and size. E: `corrupt.mp4` rejected with a message. A: corrupt MP4, wrong type and oversize. |
| MEDIA-05 | P1 | implemented | Drag and drop of files into the library; drag from library to timeline position and track. Manual check only (not covered by e2e). |
| MEDIA-06 | P1 | implemented | JPEG thumbnails generated client-side and stored privately; waveform peaks (1000) stored in asset metadata and drawn on clips. Screenshots. |
| MEDIA-07 | P1 | implemented | XHR upload progress bar, Cancel (aborts and deletes the pending asset record), Retry after failure. **Large files over 90 MB use multipart upload:** 64 MB parts, each retried up to 3×, magic bytes checked on the first part. A: 130 MB multipart test with byte-exact Range checks. Manual: a 151 MB MP4 uploaded through the UI in 11.5 s (local). |
| MEDIA-08 | P1 | implemented | User-level library; clips reference `assetId`; reused across clips and projects without re-upload. |
| MEDIA-09 | P2 | partial | Bulk multi-file import works (sequential queue). No proxy media. |

Limits: 1 GB and 20 minutes per file (multipart above 90 MB); 2 GB per user (500 MB per guest); the D1-fallback deployment also caps total storage at about 450 MB. Enforced on the server and shown in the UI.

## 4.4 Timeline

| ID | P | Status | Evidence / notes |
|---|---|---|---|
| TL-01 | P0 | implemented | Defaults V2, V1, A1, A2; tracks can be added or removed. |
| TL-02 | P0 | implemented | Add, select, move (drag or inspector), trim (edge drag or inspector), split at playhead, delete. U: commands. E: split, undo/redo, trim through inspector. |
| TL-03 | P0 | implemented | Ruler scrub, draggable playhead, zoom slider, ±, Ctrl+wheel and Fit. |
| TL-04 | P0 | implemented | Integer µs `timelineStartUs`, `sourceStartUs`, `durationUs` and `speed`. U: property test with 200 random ops. |
| TL-05 | P0 | implemented | Single store → preview and autosave. E: reload shows the same clips; export matches the edits. |
| TL-06 | P0 | implemented | Snapshot undo/redo (200 steps) including AI edits as one step. U: store tests. E: undo/redo. |
| TL-07 | P1 | implemented | Snaps to playhead, clip edges and 0 (toggle with N; Alt bypasses); snap line shown. |
| TL-08 | P1 | implemented | Track order up/down; defined overlap rule (later start on top); mute, hide and lock per track. |
| TL-09 | P1 | implemented | Copy/paste at playhead, Ctrl+D duplicate. U: paste and duplicate. |
| TL-10 | P1 | implemented | Positions snap to frame boundaries of the project fps; frame stepping; `frameToUs` and `usToFrame` documented in `time.ts`. U: time tests. |
| TL-11 | P2 | partial | Ripple delete and multiselect (Shift-click, Ctrl+A, group move) are implemented; persistent clip groups are not. |

## 4.5 Preview

| ID | P | Status | Evidence / notes |
|---|---|---|---|
| PREV-01 | P0 | implemented | Canvas compositor over all tracks, titles, captions and transforms. E: canvas pixels checked. M: screenshots. |
| PREV-02 | P0 | implemented | Play/pause, seek, frame step, timecode with duration. |
| PREV-03 | P0 | implemented | The same `evaluateVisualLayers`, compositor and audio graph run in preview and export. |
| PREV-04 | P1 | implemented | AudioContext master clock; video elements re-synced when drift exceeds 120 ms. Checked by eye only. |
| PREV-05 | P1 | implemented | 16:9, 9:16, 1:1 and 4:5 presets in the preview bar and new-project dialog. |
| PREV-06 | P1 | implemented | Preview quality: full, half or quarter resolution. |
| PREV-07 | P2 | implemented | Fullscreen (button or double-click) and safe-area guides. |

## 4.6 Titles and effects

| ID | P | Status | Evidence / notes |
|---|---|---|---|
| FX-01 | P0 | implemented | Text clips with font, size, color, background, outline, shadow, alignment, position and time range. E: title in preview and export pixels. |
| FX-02 | P0 | implemented | X/Y, scale, rotation, opacity; fit (contain, cover, stretch, original); crop per edge; drag in preview. |
| FX-03 | P1 | implemented | Fade in/out on visual (opacity) and audio (gain) clips. E: music fade-out measured in the export. |
| FX-04 | P1 | implemented | Dissolve, dip to black, wipe right and wipe left, with editable duration centered on the cut. U: timeline-eval. |
| FX-05 | P1 | implemented | Brightness, contrast and saturation through canvas `filter`. Not supported in Safari, which lacks `ctx.filter` (documented). |
| FX-06 | P1 | implemented | Speed 0.25×–4×; duration rescales; audio pitch follows speed (documented). |
| FX-07 | P2 | implemented | Linear keyframes for X, Y, scale, rotation and opacity on video, image and text clips. "Add at playhead" creates a key. Once a clip is animated, inspector edits and preview drags auto-key at the playhead. Keys show as diamonds on the clip, with a list to jump to or delete them. Keys survive split and trim-start, and preview and export share one evaluation. U: keyframes tests. E: `keyframes.spec` (motion checked in the exported MP4). No easing curves. |
| FX-08 | P2 | implemented | Title, lower-third and subtitle presets; animations: fade, slide up, pop, typewriter. |

## 4.7 Audio

| ID | P | Status | Evidence / notes |
|---|---|---|---|
| AUD-01 | P0 | implemented | All unmuted audio clips and video-clip audio are mixed in preview and export. E: `meanVolume` checks on exports. |
| AUD-02 | P0 | implemented | Per-clip volume (0–400%) and mute; trim; positioning; track volume and mute. |
| AUD-03 | P1 | implemented | Fades plus gain-point automation (created by auto-duck; cleared from the inspector). There is no manual point editor. |
| AUD-04 | P1 | implemented | Waveforms on audio clips and on video clips with audio. |
| AUD-05 | P1 | implemented | Policy: sum, then master gain, then limiter at −1 dBFS (DynamicsCompressor), identical in preview and export. |
| AUD-06 | P2 | implemented | "Auto-duck under dialogue" uses caption timing; also available as the AI op `duckMusic`. E: final-task. |

## 4.8 AI

| ID | P | Status | Evidence / notes |
|---|---|---|---|
| AI-01 | P0 | implemented | OpenAI `whisper-1` with segment and word timestamps; only the trimmed range is sent. A and E: real calls, local and production. |
| AI-02 | P0 | implemented | Words grouped into captions of up to 42 characters and 3.5 s, placed at the clip's timeline position (speed-aware). Text and timing editable (fields and drag on the caption lane). E: caption corrected. |
| AI-03 | P0 | implemented | Captions are burned in by the shared compositor (toggle). E: pixel check on the exported MP4. M: frames. |
| AI-04 | P1 | implemented | `gpt-4o-mini` with strict JSON-schema output (13 typed ops); zod validation on the server and against the live project in the client. |
| AI-05 | P1 | implemented | Each proposed op is listed with its description, rejected ops show the reason, ops can be toggled; destructive ops require a confirmation checkbox. |
| AI-06 | P1 | implemented | Applied through the shared command layer as one undoable edit. E: apply, undo, redo. |
| AI-07 | P1 | implemented | Unsupported requests are listed under "Not supported"; ops with unknown IDs are dropped on the server and rejected in the client. U: ai-actions. |
| AI-08 | P1 | implemented | `ai_operations` records status, latency, tokens, audio seconds and estimated cost; per-project history in the AI panel; totals on the admin page. |
| AI-09 | P2 | partial | **Silence removal** is implemented. The inspector's "Remove silences" tool detects silent passages from audio energy and proposes cuts with an adjustable threshold and minimum length. Each cut can be toggled and previewed (jump to it), and applying cuts the clip, ripples its track and shifts captions as one undoable edit. U: remove-ranges. E: `silence.spec`. **Filler-word removal is not implemented** (word timings aren't kept after captions are created). |
| AI-10 | P2 | implemented | Export panel → "Create 9:16 / 1:1 / 16:9 version" duplicates the project and reframes it (`reframeForAspect`): media is set to cover the frame, centered, and text and caption sizes and positions are scaled. Framing stays editable (X/Y in the inspector, or drag in the preview). The AI can also switch aspect with `setAspectRatio`. U: reframe test. E: `variants.spec`. The reframing is rule-based (centered), not subject-tracking. |

## 4.9 Export

| ID | P | Status | Evidence / notes |
|---|---|---|---|
| EXP-01 | P0 | implemented | H.264 (High) and AAC-LC 48 kHz stereo MP4 with faststart. E: ffprobe checks codec, size, fps and duration (local and production). |
| EXP-02 | P0 | implemented | Trim, split, placement, layers, titles and audio mix. E and M: source timecode in frames matches the split mapping; title and logo pixels; audio levels. |
| EXP-03 | P0 | implemented | `/api/exports/:id/download` requires the owner's session and supports Range. A: other user gets 404. |
| EXP-04 | P0 | implemented | Live frame progress in the UI; server job status `queued → running(progress) → completed/failed/canceled`. |
| EXP-05 | P1 | implemented | 720p and 1080p presets; 24–60 fps. |
| EXP-06 | P1 | implemented | Captions, transitions, color effects and aspect ratio all go through the shared compositor. |
| EXP-07 | P1 | implemented | Failure or cancel marks the job, shows a Retry button, and leaves the project untouched (export renders a snapshot). A: transition rules. |
| EXP-08 | P1 | implemented | Export history with download and delete per project. |
| EXP-09 | P2 | partial | Persisted job states, a stale-job sweeper (cron) and per-user rate limit. Rendering is in the browser, so jobs are not resumable after the tab closes. |

## 4.10 Persistence

| ID | P | Status | Evidence / notes |
|---|---|---|---|
| DATA-01 | P0 | implemented | `schemaVersion` 2 JSON validated by zod on the client and server. |
| DATA-02 | P0 | implemented | E: reload and sign-out/sign-in reopen show the same timeline. |
| DATA-03 | P0 | implemented | Assets are owner-scoped; storage keys are derived on the server. A: isolation. |
| DATA-04 | P1 | implemented | Debounced autosave (1.2 s), visible state, version-checked PUT (409, then "Load latest" or "Keep mine"), retry when offline, warning before unload. |
| DATA-05 | P1 | implemented | `migrateProject` with step-wise migrations (v1 → v2). U: migration tests. |
| DATA-06 | P1 | implemented | Duplicate and rename. A. |
| DATA-07 | P2 | implemented | Automatic revisions (at most one every 2 minutes, last 30 kept) with restore. A: revisions and restore. |
| DATA-08 | P2 | partial | Versioned documents and optimistic concurrency. No real-time collaboration (not required). |

## 4.11 Operations

| ID | P | Status | Evidence / notes |
|---|---|---|---|
| OPS-01 | P0 | implemented | `/api/health` checks the DB, storage and whether OpenAI is configured; no secrets. A. |
| OPS-02 | P1 | implemented | `/admin`: users, projects, storage, exports and AI cost (aggregates only; admin = `ADMIN_EMAILS`). A: 403 and 200. |
| OPS-03 | P1 | implemented | Ranges: 1h, 24h, 3d, 7d. |
| OPS-04 | P1 | implemented | JSON log lines with `requestId` and `X-Request-Id` on every response; error bodies include the requestId. |
| OPS-05 | P1 | implemented | Quotas and abuse controls documented in the README and BUILD_REPORT. |
