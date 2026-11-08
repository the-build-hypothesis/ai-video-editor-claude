# BUILD_REPORT — FrameForge (AI video editor)

Agent: Claude Code (Claude Opus 5.5). Run started 2026-11-07 16:57 EST.

## 12.1 Executive summary

FrameForge is a working browser video editor deployed on Cloudflare. In the deployed app, a tester can:
- create an account or continue as a guest, and import MP4, PNG/JPEG and MP3/WAV media;
- arrange clips on a multitrack timeline (2 video and 2 audio tracks by default; more can be added);
- trim, split, move, layer, fade and transition clips; add titles and color adjustments; mix audio;
- transcribe speech with OpenAI Whisper into editable, burned-in captions;
- ask the AI assistant for edits, review the proposed typed operations, apply them as one undoable step;
- save and reopen projects;
- export a real **H.264/AAC MP4**, rendered in the browser and stored privately in their account.

- **Deployment:** https://ai-video-editor-v1-claude.thebuildhypothesis.com (health: `/api/health`).
- **Source commit:** see `git log -1` on `main` (final SHA in the handoff message).
- **Real MP4 export generated and inspected:** yes.
  - ffprobe on the §8.2 output: H.264 High 1920×1080 at 30/1 fps, 900 frames, AAC-LC 48 kHz stereo, 30.016 s.
  - Frames at the beginning, middle and end were extracted and checked visually and by pixel assertions in automated tests.
  - Exports were generated both locally and against the production deployment.
- **Major accomplishments:**
  - One shared renderer for preview and export, so the two stay consistent.
  - Integer-µs canonical model with zod validation and migrations.
  - Every P0 requirement implemented and tested end to end, including the full §8.2 task automated against production with real OpenAI calls.
  - Cross-user isolation tested.
  - Failure-recovery paths tested (upload, transcription, AI plan, export, autosave conflict).
  - axe accessibility scan clean.
- **Main limitations:**
  1. **R2 is not enabled** on the Cloudflare account (`code 10042`). Media and exports therefore live in a D1 chunked-blob fallback, capped at 450 MB total by a guard. Enabling R2 and redeploying with `npm run deploy` switches to R2 with no code changes.
  2. Rendering happens in the browser tab; it needs WebCodecs H.264, so recent desktop Chrome/Edge are expected to work. Only Chromium 158 on Linux was verified.
  3. Uploads over 90 MB use multipart (64 MB parts) to stay under the Workers 100 MB request limit. While on D1 storage, total media and export storage is about 450 MB.
  4. No password reset: there is no email provider (AUTH-04 blocked).

## 12.2 Architecture

**Stack:**
- TypeScript everywhere: React 19 + Vite 8 + zustand on the client; Hono 4 on Cloudflare Workers.
- D1 (SQLite) for metadata and fallback blob storage; R2-ready storage layer.
- zod schemas shared by client and server.
- mediabunny (WebCodecs demux/decode/encode/mux) plus `@mediabunny/aac-encoder` (WASM AAC) for export.
- OpenAI REST API (`whisper-1`, `gpt-4o-mini`) called from the Worker.

**Rationale:**
- Workers can't run long native FFmpeg encodes, so encoding happens in the browser with WebCodecs. That gives hardware/OS H.264 where available and needs no extra paid infrastructure.
- Everything except AI and storage stays client-side, so preview and export can share code exactly.

**Components and data flow:**
1. **Editor UI** (`src/client/components`): media library, preview, inspector, captions, AI, export, timeline. All edits go through `useEditor.edit(label, command)`.
2. **Canonical model** (`src/shared/model.ts`): tracks, clips (video/image/audio/text), transforms, crop, color adjustments, fades, transitions, gain automation, captions with style, settings. zod-validated on every edit (client), every save (Worker) and every load (`migrateProject`).
3. **Command layer** (`src/shared/commands.ts`): pure functions such as `addClip`, `moveClip`, `trimClip`, `splitClip`, `updateClip`, `setTransition`, `rippleDelete`, `removeRangesFromClip`, caption ops and `duckUnderCaptions`. Undo/redo stores snapshots (200 deep). AI operations (`src/shared/ai-actions.ts`) call the same commands.
4. **Preview engine** (`src/client/engine/preview.ts`): an AudioContext clock drives a requestAnimationFrame loop. One hidden `<video>` per visible clip, re-synced when drift exceeds 120 ms. Images are decoded once as ImageBitmaps. Audio uses the shared mix graph.
5. **Media service:** uploads stream to `/api/assets/:id/content`. Before upload, the client checks the file:
   - it validates type and size;
   - it decodes the file to confirm it can be read and isn't corrupt;
   - it extracts metadata, a JPEG thumbnail and waveform peaks.

   The server re-checks Content-Length and magic bytes, then serves Range requests privately.
6. **AI service** (`src/worker/routes/ai.ts`, `src/worker/openai.ts`):
   - **Transcription:** the client sends only the trimmed range of the clip as 16 kHz mono WAV. The Worker forwards it to Whisper with word and segment timestamps.
   - **Planning:** the Worker builds a grounded description of the project from the saved project (ownership checked), asks gpt-4o-mini for strict JSON-schema output, validates with zod, and drops unknown IDs.
   - **Accounting:** usage, latency and estimated cost go into `ai_operations`.
7. **Render service** (`src/client/engine/exporter.ts`):
   - For each frame *n*, it takes t = round(n·1e6/fps), evaluates the timeline with `evaluateVisualLayers`, gets exact frames from per-clip sequential WebCodecs decoders (rotation-aware), and draws them with the shared `renderFrame` onto an OffscreenCanvas, which feeds the H.264 encoder.
   - Audio uses the same mix graph in an OfflineAudioContext, then AAC.
   - The result is muxed to MP4 with faststart and uploaded to `/api/exports/:id/file`.
   - Job state is tracked on the server.
8. **Persistence and API** (`src/worker/routes/*`, `docs/API.md`):
   - **Auth:** PBKDF2 passwords; hashed session tokens in an HttpOnly cookie.
   - **Data:** owner-scoped projects with version numbers and revisions; assets; exports.
   - **Request guards:** CSRF header requirement and rate limits.
9. **Operations:** `/api/health`, `/admin` metrics (aggregates only), JSON logs with request IDs, and a daily cron to purge guests and stale uploads.

**Timebase (5.3):**
- All times are integer microseconds. A clip covers `[start, start + duration)`, end exclusive.
- Source time = `sourceStart + (t − start) × speed`.
- Export frame *n* is sampled at `round(n·1e6/fps)`; the frame count is the number of frame starts before the duration.
- Edits snap to frame boundaries of the project fps.
- A split creates `[start, at)` and `[at, end)`; the right piece gets `sourceStart + (at − start) × speed`, so there are no gaps or duplicated frames (unit-tested).
- **Same-track overlaps** are allowed, with a deterministic rule: the later start draws on top, and audio clips mix.
- **Layering:** tracks higher in the list draw on top.
- **Transitions** are centered on the cut, over `[cut − d/2, cut + d/2)`. If the source runs out, the edge frame is held.

**Preview/render consistency:**
- `timeline-eval.ts` (pure, unit-tested) determines layers, opacity, transitions and audio segments for both preview and export.
- `compositor.ts` draws text, captions, transforms, crops and filters for both.
- `audio-graph.ts` schedules the identical gain envelopes (fades plus automation) and limiter.
- Only the frame source differs between the two (`<video>` vs exact decoded frames). Rotation metadata is honored on both sides; this was found and fixed with a dedicated test.

**Storage, auth, background processing, OpenAI:**
- **Storage:** D1 holds metadata. The object store is R2 when the `MEDIA` binding exists, otherwise 1 MB D1 chunks; the current deployment uses the D1 fallback.
- **Auth:** cookie sessions; guests can register later and keep their projects.
- **Background processing:** the exporter is client-driven with server-tracked job states plus a stale-job cron.
- **OpenAI:** models are configured by `OPENAI_MODEL=gpt-4o-mini` and `OPENAI_TRANSCRIPTION_MODEL=whisper-1` vars. The key is a Worker secret.

**External dependencies:**
- OpenAI availability and quota: AI features degrade to clear errors with a retry button, and manual editing is unaffected.
- The browser's WebCodecs support: export is disabled with an explanation if H.264 encoding is unavailable.

## 12.3 Implementation chronology (EST, 2026-11-07)

| Time | Milestone |
|---|---|
| 16:57 | Assignment received. Environment inspection: no sudo; Playwright Chromium missing `libnss3/libnspr4/libasound` (extracted via `apt download` into `~/.local/pwlibs`, outside the repo); codec probe showed H.264 encode available and AAC encode not, so the WASM AAC encoder was chosen. |
| 17:05–17:12 | Synthetic fixtures generated (ffmpeg test sources + Windows TTS speech). Cloudflare token verified. **Human intervention 1:** `cloudflare.env` pointed at an existing, live "ai-travel-planner" Worker; I asked how to proceed instead of overwriting it, and the user said to rename the references to `ai-video-editor`. D1 created; **R2 creation failed: not enabled on the account (blocker).** |
| 17:31 | Scaffold, shared model, commands and AI schema committed. The backend was delegated to a parallel sub-agent, working in its own files, while I built the editor. |
| ~17:45 | Backend done: 23 unit + 22 API tests, real OpenAI transcription and plan verified locally. |
| 17:48 | **First runnable app** (editor and Worker). |
| 17:49 | **First uploaded asset, first timeline edit, first preview, first successful export** (e2e: 720p MP4 inspected with ffprobe). |
| 17:51 | D1 chunked-storage fallback implemented because R2 is unavailable. |
| 17:52 | **First deployment** (custom domain live; health OK). |
| 17:55 | **First AI features in the browser:** transcription to captions burned into the export, and AI plan to apply to undo. In production the first attempt failed with HTTP 401 because the key in `.dev.vars` was quoted; re-provisioned the secret without quotes and sanitized provider errors so they no longer echo masked keys. |
| 18:03 | All API and e2e suites pass against production. |
| 18:05–19:30 | Unit-test suite (204 tests via a second sub-agent; found and fixed 5 shared-logic bugs); §8.2 final-task e2e; inspector a11y labels; image native-size default; light-mode contrast; **rotation-metadata export bug** found and fixed; Journey E failure-recovery and conflict tests; AI planner quality fixes; axe scan and fixes; AI-09 silence removal; D1 capacity guard; admin-allowlist security fix. |
| 19:31 | Deployment `d4a3fb7d`; production re-verified. Later deploys are listed at the end of this report. |

**Blockers and recovery:**
1. Missing Chromium system libraries: extracted locally, without root.
2. R2 not enabled: D1 blob fallback plus capacity guard. Asked the user to enable R2.
3. Quoted OpenAI key: re-provisioned the secret.
4. Cloudflare's edge rejects a client-supplied `CF-Connecting-IP`: API tests send it only to localhost.
5. Test races (inspector not yet switched; HMR during a parallel agent's edits): made the helpers wait and made `NumField` read the live DOM value.

**Independent code review (around 20:10):** a separate reviewing agent read the export, preview, command, store and storage code with no hints. It reported 12 issues, all of which I fixed:
- Gain automation shifted when a clip's start was trimmed.
- Edits could be lost when leaving the editor during an in-flight save.
- A stale save response could overwrite another project's version number.
- Reframing for social formats ignored keyframes.
- Each clip's decoder stayed open until the end of the export.
- Overlapping cut ranges were skipped.
- On failure or cancel, the export left its encoders open.
- Re-decoding past the end of the source media.
- Stuttering preview during transitions.
- A second play press while audio was loading started playback twice.
- Late audio scheduling wasn't compensated.
- Unfinished multipart uploads weren't counted against the storage cap.

Regression tests were added for the logic fixes.

**Human approvals and interventions:**
1. One clarification about the deployment target. The supplied config named another project's live Worker; the user said to rename it to `ai-video-editor`. It took a few minutes of wall-clock time.
2. Permission prompts and denials from the auto-mode safety classifier:
   - a command that would have printed non-secret env values was denied, so I worked from names only;
   - a command to bulk-delete test data from the production database was denied. I did not retry; the decision is left to the user.
3. No human code or design input.

## 12.4 Feature status

See [FEATURE_MATRIX.md](FEATURE_MATRIX.md).

- **P0:** all implemented and covered by automated tests, locally and in production.
- **P1:**
  - All implemented except AUTH-04 (password reset), which is **blocked** with no email provider.
  - **Verified only by manual inspection, not automated tests:** AUD-03 (no manual gain-point editor), PREV-04 (sync checked by eye) and MEDIA-05 (drag-and-drop gestures).
- **P2:**
  - Implemented: PREV-07, FX-07, FX-08, AUD-06, DATA-07, AI-10.
  - Partial: MEDIA-09 (bulk import, no proxies), TL-11 (no persistent groups), AI-09 (silence removal only, no filler words), EXP-09 (in-browser render, not resumable), DATA-08.
  - FX-07 (keyframes) is also implemented: linear keyframes for X, Y, scale, rotation and opacity, with auto-key.

## 12.5 Verification

See [TEST_RESULTS.md](TEST_RESULTS.md) for exact commands and counts:
- 208 unit tests;
- 22 API tests;
- 9 browser e2e tests: Journeys A–E, the §8.2 final task, media compatibility, silence removal and the axe scan.

All pass locally; in production the API suite, the light e2e specs and the §8.2 spec have each passed.

- **End-to-end workflows exercised:** guest first edit; registered return later; AI captions; AI-directed edit with confirmation and undo; failure recovery including an autosave conflict; the full §8.2 task with two exports; cross-user denial.
- **Export verification:** ffprobe of codec, profile, resolution, fps, frame count, duration and audio stream. ffmpeg frame extraction and pixel assertions for title, logo, captions and full-frame content. `volumedetect` checks for dialogue presence and music fade-out. Contact sheets are in `artifacts/` (not committed).
- **Known bugs and limitations:**
  - Preview frames for MP4s that keep their index at the end of the file take ~2 s to appear on first seek in production (range fetch of the index); a "Loading media…" overlay shows meanwhile.
  - Caption chunks built from Whisper word timings carry no punctuation, because whisper-1 word tokens are unpunctuated.
  - Speed changes shift audio pitch (by design, documented).
  - Switching directly from one project to *another* project while a save is in flight can drop that last pending edit; leaving to the dashboard flushes correctly. Rare, not fixed.
  - The color filters (brightness, contrast, saturation) need canvas `filter`, which Safari lacks.

## 12.6 Security and operational readiness

- **Authorization:**
  - Every project, asset, export and AI query is scoped by `owner_id`; other users' resources return 404, verified by API and browser tests.
  - The admin page shows aggregates only. Admin rights come from an allowlist that is a Worker **secret** (`ADMIN_EMAILS`), not committed.
  - The production admin account was registered by the operator with a generated password stored only in the untracked `.admin-credentials` file.
  - An earlier test-created admin account whose password is visible in the test code was **demoted** by moving the allowlist; verified with a 403.
- **Validation:**
  - zod on every request body.
  - Project JSON is limited to 2 MB and validated against the schema.
  - Colors are restricted to hex; text renders only on canvas (no HTML), so there's no injection path.
  - Storage keys are derived on the server from validated IDs, so there's no path traversal.
  - Uploads require Content-Length and pass magic-byte sniffing; corrupt media is rejected on both client and server.
- **Sessions:** 32-byte random tokens, stored only as SHA-256 hashes; cookie is HttpOnly, Secure and SameSite=Lax. Mutating requests also require the custom `X-FF-Client` header.
- **Rate limits:**
  - Login: 10 per 15 minutes per IP+email.
  - Registration and guest creation: per IP.
  - AI: 60 calls per hour per user. Exports: 30 per hour per user.
- **Storage quotas:** 2 GB per registered user, 500 MB per guest, plus the global D1 guard (507 `storage_full`).
- **Secrets:** `OPENAI_API_KEY` and `ADMIN_EMAILS` are Worker secrets. `.dev.vars`, `cloudflare.env` and `.admin-credentials` are gitignored, and `.dev.vars.example` lists names only. Provider error bodies are not forwarded to clients. Logs contain no passwords, tokens, keys or transcripts.
- **Media privacy:**
  - Only the trimmed audio range (16 kHz mono WAV) of the clip being transcribed is sent to OpenAI.
  - The planner receives project structure, asset names, text-clip text and up to 20 caption lines, marked as untrusted data.
  - OpenAI's API data-usage policy applies.
  - Guests and their data are purged after 7 days of inactivity. Deleting an asset or export removes its stored bytes.
  - **Self-service account deletion** (account menu → "Delete account & data"; registered users re-enter their password) removes the user and all projects, media, exports and revisions. AI usage rows are anonymized, not deleted: they hold no content and keep cost totals accurate.
- **Reliability limits:** rendering depends on the user's tab. Exports stuck in queued or running for over 24 h are marked failed by cron.
- **Deployment resources:**
  - Worker `ai-video-editor-claude` with custom domain `ai-video-editor-v1-claude.thebuildhypothesis.com`.
  - D1 database `ai-video-editor-claude-db`.
  - Secrets: `OPENAI_API_KEY`, `ADMIN_EMAILS`. Cron: `17 3 * * *`.

## 12.7 Cost and resource usage

- **OpenAI usage recorded by the app in production (7-day window at report time):** 15 calls (9 transcriptions, 6 plans, 2 failed), 88.6 s of audio, 7,519 input and 1,289 output tokens, **estimated $0.0108**.
- **Local runs:** a similar order of magnitude (each local run of the AI e2e specs costs under $0.01).
- **Pricing used by the estimator:** whisper-1 $0.006/min; gpt-4o-mini $0.15 per 1M input tokens and $0.60 per 1M output tokens.
- **Total OpenAI spend for the session:** estimated **under $0.10**. Not reconciled against the OpenAI billing dashboard (no access).
- **Cloudflare:** Workers + D1 within included usage. Production D1 holds about 255 MB of mostly test media and exports. Rendering compute is the user's browser, at no server cost.

## 12.8 Decisions and tradeoffs

- **Browser export vs. an external render service.** I chose browser export, which needs no extra infrastructure and shares the preview code. The cost is client CPU and memory, and the tab must stay open. Rejected: FFmpeg.wasm (slower, larger download, needs COOP/COEP) and an external FFmpeg service (not provisioned, would need separate deployment and credentials).
- **D1 blob fallback instead of blocking on R2.** It keeps the product deployable and testable. The cost is the D1 size cap and lower throughput. R2 remains the intended production store; flip by enabling R2 and running `npm run deploy`.
- **Snapshot undo instead of inverse operations.** Simple and correct for small JSON projects.
- **One schema for AI operations with nullable fields.** This fits OpenAI strict structured output. Each field is validated per op type in code.
- **Same-track overlap allowed with a deterministic top-most rule**, instead of forbidding overlaps. Easier dragging, and the rule is documented.
- **Deferred:**
  - password reset (needs an email provider);
  - proxy media;
  - filler-word removal (needs word timings stored in the project);
  - server-side rendering for closed tabs.
- **Needed for production quality:**
  - Enable R2 (multipart is already implemented for it, but untested against real R2) and make uploads resumable across page reloads.
  - Email verification and password reset.
  - Real-browser test matrix (Safari, Firefox, Windows/macOS Chrome).
  - Error monitoring and alerting.
  - Load tests.
  - A server-side render fallback, or an option for unsupported browsers.

## 12.9 Next steps

1. Enable R2 on the account, deploy with R2, and verify the R2 multipart path against real R2 (implemented, but only tested with the D1 store).
2. Cross-browser verification (Safari: canvas `filter` fallback for color effects; Firefox WebCodecs).
3. Email provider for password reset and verification, so admin access depends on a verified email.

**Top technical risks:**
- Browser codec and WebCodecs variability for unusual source media.
- Memory use on long or high-resolution projects, since whole source files are loaded into memory for export.
- The D1 storage cap until R2 is enabled.

**Recommended next milestone:** R2 enablement and verification, cross-browser QA, keyframe easing, and filler-word cuts from stored word timings.
