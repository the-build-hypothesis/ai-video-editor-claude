# FrameForge — AI-assisted browser video editor

FrameForge is a browser-based, multitrack video editor:

- Import MP4, PNG/JPEG and MP3/WAV media.
- Arrange, trim, split and layer clips on video and audio tracks.
- Add titles, transitions, fades and color adjustments, and mix audio.
- Transcribe speech into editable captions with OpenAI, then burn them into the video.
- Describe edits in natural language and review the proposed typed operations before applying (undoable).
- Export a real **H.264/AAC MP4**.

**Live deployment:** https://ai-video-editor-v1-claude.thebuildhypothesis.com (health: `/api/health`)

Project status, verification evidence and limitations: [BUILD_REPORT.md](BUILD_REPORT.md) · [FEATURE_MATRIX.md](FEATURE_MATRIX.md) · [TEST_RESULTS.md](TEST_RESULTS.md) · API: [docs/API.md](docs/API.md)

## Architecture

```
Browser (React 19 + Vite)                                 Cloudflare Worker (Hono, TypeScript)
┌──────────────────────────────────────────────┐          ┌──────────────────────────────────────┐
│ Editor UI (media, preview, inspector,        │  /api/*  │ auth (PBKDF2, cookie sessions)       │
│   timeline, captions, AI, export panels)     │ ───────► │ projects (versioned JSON, conflicts, │
│ zustand store → shared command layer         │          │   revisions)                         │
│   (undo/redo snapshots, autosave)            │          │ assets (streaming upload, magic-byte │
│ Preview engine: canvas compositor +          │          │   check, Range download)             │
│   Web Audio mix                              │          │ exports (job state + MP4 storage)    │
│ Exporter: same compositor → WebCodecs H.264  │          │ AI: OpenAI whisper / gpt-4o-mini     │
│   + AAC → mediabunny MP4 mux                 │          │ health, admin metrics, cron cleanup  │
└──────────────────────────────────────────────┘          └───────────┬───────────────┬──────────┘
            src/shared: project schema (zod), commands, timeline     D1 (metadata,  R2 media bucket
            evaluation, AI action schema — used by BOTH sides        fallback blobs) (when enabled)
```

- **Canonical model** (`src/shared/model.ts`, schema v2): integer **microsecond** timebase. A clip occupies `[timelineStartUs, timelineStartUs+durationUs)` and maps source time as `sourceStartUs + (t − start) × speed`. Export frame *n* is sampled at `round(n·1e6/fps)`. The schema is validated with zod on every edit, every save (server) and every load. Migrations live in `src/shared/migrate.ts` (v1 → v2).
- **One renderer for preview and export.**
  - `src/shared/timeline-eval.ts` decides which layers and audio segments are active at time *t*.
  - `src/client/engine/compositor.ts` draws them, and `src/client/engine/audio-graph.ts` builds the Web Audio mix.
  - The preview feeds the compositor `<video>` frames and plays the mix in an `AudioContext`. The exporter feeds it exact WebCodecs-decoded frames and renders the same mix graph in an `OfflineAudioContext`.
- **Export runs in the browser** (WebCodecs + [mediabunny](https://mediabunny.dev)). Cloudflare Workers cannot run long video encodes, so the Worker only tracks job state (`queued → running → completed | failed | canceled`) and stores and serves the finished MP4 privately. AAC is encoded natively where the browser supports it; otherwise the `@mediabunny/aac-encoder` WASM encoder is used (for example Chromium on Linux). If H.264 encoding isn't available, export is disabled with a clear message; no other codec is substituted.
- **Storage:** media and exports live in **R2** when the `MEDIA` binding exists. When R2 isn't enabled on the account, build with `FF_STORAGE=d1` and the Worker stores objects as 1 MB chunks in D1 (`src/worker/d1-blob.ts`). The current deployment uses that fallback; see BUILD_REPORT.
- **AI** (server-side only; the key never reaches the browser):
  - **Transcription:** `OPENAI_TRANSCRIPTION_MODEL` (default `whisper-1`) returns segment and word timestamps. Only the trimmed part of the clip is sent, as 16 kHz mono WAV.
  - **Editing:** `OPENAI_MODEL` (default `gpt-4o-mini`) uses strict JSON-schema structured output. It returns typed operations, which are validated on the server and again in the client, previewed, and applied through the same command layer as manual edits, so the whole edit is a single undo step.

## Local development

Requirements: Node 20+ (tested on Node 26), npm, a Chromium-based browser.

```bash
npm install
cp .dev.vars.example .dev.vars              # then set OPENAI_API_KEY (no quotes needed)
npx wrangler d1 migrations apply DB --local -c wrangler.jsonc
npm run dev                                 # http://localhost:5173  (Vite + Worker in workerd, local D1/R2)
# FF_STORAGE=d1 npm run dev                 # exercise the D1 storage fallback locally
```

## Environment variables

| Name | Where | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | **secret** (`.dev.vars` locally, `wrangler secret put OPENAI_API_KEY` in prod) | OpenAI transcription + edit planning. Never in source, config or client. |
| `OPENAI_MODEL` | `wrangler.jsonc` vars | Edit-planning model (default `gpt-4o-mini`). |
| `OPENAI_TRANSCRIPTION_MODEL` | vars | Speech-to-text model (default `whisper-1`; word timings need `whisper-1`). |
| `ADMIN_EMAILS` | vars | Comma-separated registered emails that get the admin metrics page. |
| `APP_PUBLIC_URL`, `APP_PUBLIC_HOSTNAME` | vars | Public URL / hostname (custom domain route). |
| `DB` | D1 binding | Metadata (users, sessions, projects, revisions, assets, exports, AI ops, rate limits, fallback blobs). |
| `MEDIA` | R2 binding (optional) | Media + export objects. Omitted when built with `FF_STORAGE=d1`. |
| `FF_STORAGE` | build-time env | `d1` = build without the R2 binding (fallback storage). |

`RENDER_SERVICE_URL/TOKEN` are not used (no external renderer). `EMAIL_FROM` is not used: there is no transactional email provider, so password reset is not implemented.

## Tests

```bash
npm run typecheck            # tsc --noEmit
npm run lint                 # eslint
npm test                     # vitest unit tests (shared model/commands/timeline/AI actions + worker logic)
npm run build
# Browser + API tests (starts/reuses the dev server on :5173):
npx playwright test                                   # api + e2e projects
SKIP_REAL_AI=1 npx playwright test                    # skip tests that call OpenAI (cost)
API_BASE_URL=https://ai-video-editor-v1-claude.thebuildhypothesis.com npx playwright test   # against production
```

The e2e tests export real MP4s and inspect them with `ffprobe`/`ffmpeg` (from the `ffprobe-static`/`ffmpeg-static` dev dependencies). Results are written to `artifacts/`. If Playwright's Chromium is missing system libraries and you can't install them, extract `libnspr4 libnss3 libasound2t64` with `apt download` and set `LD_LIBRARY_PATH`.

Synthetic, rights-free sample media is in `fixtures/` (generated by `scripts/make-fixtures.sh`).

## Deployment (Cloudflare)

```bash
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
npx wrangler d1 create ai-video-editor-claude-db           # once; put the id in wrangler.jsonc
npx wrangler d1 migrations apply DB --remote -c wrangler.jsonc
npx wrangler secret put OPENAI_API_KEY                      # paste the key (no quotes)
# With R2 enabled on the account:
npx wrangler r2 bucket create ai-video-editor-claude-media && npm run build && npx wrangler deploy
# Without R2 (current deployment):
FF_STORAGE=d1 npm run build && npx wrangler deploy
```

`npm run build` writes `dist/` including the generated Worker config, and `wrangler deploy` picks it up. The custom domain is configured in `routes` in `wrangler.jsonc`. A daily cron (`17 3 * * *`) removes expired guests and sessions and stale uploads, and fails stuck export jobs.

## Limits and supported browsers

- **Per file:** up to 1 GB and 20 minutes. Files over 90 MB upload as 64 MB parts (R2 multipart, or chunk-offset writes in the D1 fallback), which stays under the Workers 100 MB request-body limit. In the current D1-storage deployment, total storage is capped at about 450 MB.
- **Storage per account:** 2 GB for registered users, 500 MB for guests. Guests are kept for 7 days of inactivity.
- **Rate limits:** 60 AI calls/hour/user and 30 exports/hour/user. Login and registration are also rate-limited by IP.
- **Export:** stored exports are capped at 100 MB. Larger renders can still be downloaded locally.
- **Browsers:**
  - Verified: Chromium 158 (Playwright, Linux) for preview, export and all tests.
  - Recent desktop Chrome and Edge are expected to work.
  - Not verified: Safari 17+ and Firefox 130+. They have WebCodecs, but Safari lacks canvas `filter` (color adjustments would not render there).
- **Codecs:** source video must be decodable by the browser (H.264 MP4 recommended).
- **Speed and pitch:** speed changes resample audio, so pitch follows speed.

## License

Apache-2.0 (see `LICENSE`). Sample media in `fixtures/` is synthetic (ffmpeg test sources + Windows TTS voice) and created for this project.
