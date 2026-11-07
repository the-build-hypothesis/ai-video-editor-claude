# The Build Hypothesis — AI Video Editor
## Experiment 2: Eight-Hour Autonomous Coding Agent Challenge

**Specification version:** 1.1  
**Project codename:** FrameForge (working name; may be renamed without affecting requirements)  
**Status:** Implementation-ready  
**Target agents:** Claude Code, Cursor CLI, OpenAI Codex  
**Maximum agent execution time:** 8 hours per agent  
**Primary deployment target:** Cloudflare  
**Primary audience:** Creators who need a capable browser-based video editor

---

## 1. Mission

Build a real, usable, browser-based, AI-assisted video editor. The application must allow users to import media, arrange and edit clips on a multitrack timeline, preview the composition, add titles and captions, mix audio, save projects, and export a playable MP4. AI-assisted features must produce actionable edits or assets, not just chat responses.

This is a **product-building assignment**, not a mockup or proof of concept. Build the strongest working implementation possible within the allotted time. The agent is expected to plan, implement, run, test, inspect, repair, and improve the application autonomously until the time limit or until the acceptance criteria are demonstrably met.

### 1.1 Success definition

A successful submission is an accessible, deployed application in which a tester can import the supplied media, edit a short video, generate or edit captions, save and reopen the project, and export an MP4 whose visual and audio content matches the timeline.

**A beautiful UI without working editing and export does not meet the mission.** Equally, a functional processing pipeline without a usable editing interface is incomplete.

### 1.2 Priorities

1. Correctness and end-to-end usability.
2. Timeline, preview, and export consistency.
3. Reliable save/reload and recoverable failures.
4. AI functionality that performs real, reviewable work.
5. Design quality, performance, accessibility, and polish.

---

## 2. Experiment rules and agent autonomy

### 2.1 Equal conditions

- Each agent receives this exact specification, the same starting repository structure, equivalent environment variables and credentials, and the same evaluation media package.
- Each agent receives a fresh, isolated GitHub repository and Cloudflare deployment target.
- The timer is **8 hours of wall-clock time**, beginning when the agent receives the assignment and has access to its environment.
- Time spent planning, installing dependencies, generating code, running tests, deploying, debugging, and writing reports counts toward the limit.
- The agent may select libraries, frameworks, internal architecture, and implementation order, subject to the constraints below.
- No human-written code, fixes, design decisions, or architecture guidance will be supplied during a run.
- Human involvement is limited to unavoidable credential provisioning, infrastructure permissions, and security/approval prompts. Every intervention must be recorded.
- If a command or permission requires approval, request only the necessary approval and proceed when permitted. Never bypass security boundaries.
- Agents must not be judged on a feature that depends on a missing secret or unavailable external service without recording that limitation.

### 2.2 Continue after initial completion

**Do not stop merely because the initial application builds, deploys, or appears feature-complete.** Continue to run real user flows, execute automated tests, inspect exported videos, find defects, improve usability, and address failures. If all acceptance criteria are satisfied, spend remaining time on reliability, accessibility, performance, and high-value stretch features.

The agent must not invent test results or claim a feature works without validation. An untested feature must be identified as unverified.

### 2.3 Agent decision-making

Make reasonable technical decisions without requesting routine clarification. Document assumptions and tradeoffs in the final build report. If a feature cannot be completed, preserve a working application and clearly identify the limitation rather than substituting a fake control or misleading demo.

---

## 3. Users and key workflows

### 3.1 User roles

- **Guest editor:** Can create and edit a temporary project, subject to reasonable limits. Persistence across browser restarts is not guaranteed for guests; communicate this clearly.
- **Registered creator:** Can create an account, sign in, save projects, reopen them, and manage their own media and exports.
- **Administrator:** Can inspect operational health and aggregate usage metrics; must not receive unrestricted access to private user media merely by being an administrator.

### 3.2 Required user journeys

**Journey A — First edit:** Open the editor, create a project, upload clips and audio, arrange them, trim them, add a title, preview the result, and export.

**Journey B — Return later:** Sign in, reopen a saved project, find the same timeline, media, text, edits, and settings, make another change, and export again.

**Journey C — AI captions:** Select a video containing speech, request transcription, review generated caption segments, correct text/timing, display captions in the preview, and export captions burned into the video.

**Journey D — AI-directed edit:** Enter an instruction such as “Add a title at the start and fade the music out at the end.” The system proposes structured changes, allows review/confirmation, applies them, and supports undo.

**Journey E — Failure recovery:** Encounter a failed upload, transcription, or export and receive an actionable error with a safe retry path, without corrupting the project.

---

## 4. Product scope and feature requirements

Requirement IDs are stable for test reporting. **P0** means core acceptance, **P1** means required target after P0 is reliable, and **P2** means stretch. P1 items are still part of the requested product; priority determines implementation order, not permission to fake them.

### 4.1 Application shell and navigation

| ID | Priority | Requirement |
|---|---|---|
| APP-01 | P0 | Responsive desktop-first application with project dashboard, editor, and account controls. |
| APP-02 | P0 | Clear loading, saving, processing, success, and error states. |
| APP-03 | P0 | Project creation, rename, open, and delete with confirmation. |
| APP-04 | P1 | Keyboard shortcuts and a discoverable shortcut reference. |
| APP-05 | P1 | Light/dark-friendly accessible contrast; dark editor theme is acceptable. |
| APP-06 | P1 | Empty states and first-use guidance; no nonfunctional placeholder controls. |

### 4.2 Authentication and authorization

| ID | Priority | Requirement |
|---|---|---|
| AUTH-01 | P0 | Email/password registration, login, logout, and secure session handling. |
| AUTH-02 | P0 | Project, asset, and export ownership enforced on every server-side operation. |
| AUTH-03 | P0 | Guest editing available without mandatory account creation. |
| AUTH-04 | P1 | Password reset through a configured transactional email provider if credentials are available. |
| AUTH-05 | P1 | Rate limiting for login and password reset, with safe error messages. |

Passwords must use a modern password hashing scheme; never store plaintext passwords or session secrets in the client bundle.

### 4.3 Media import and asset library

| ID | Priority | Requirement |
|---|---|---|
| MEDIA-01 | P0 | Import MP4 video, JPEG/PNG images, and MP3/WAV audio. |
| MEDIA-02 | P0 | Display media metadata: name, type, duration when applicable, dimensions, and upload state. |
| MEDIA-03 | P0 | Add imported media to timeline using an obvious interaction. |
| MEDIA-04 | P0 | Prevent unsupported/corrupt media from silently breaking the project. |
| MEDIA-05 | P1 | Drag-and-drop upload and timeline insertion. |
| MEDIA-06 | P1 | Generate thumbnail previews and audio waveform visualizations. |
| MEDIA-07 | P1 | Upload progress, retry, and safe cancellation for large assets. |
| MEDIA-08 | P1 | Asset reuse across multiple clips without duplicating original uploads. |
| MEDIA-09 | P2 | Bulk media import and proxy media for heavy source files. |

Set and document file-size, duration, and project storage limits. Enforce limits server-side and communicate them before upload where possible.

### 4.4 Timeline editor

| ID | Priority | Requirement |
|---|---|---|
| TL-01 | P0 | Timeline supports at least two video/visual tracks and two audio tracks. |
| TL-02 | P0 | Add, select, move, trim start/end, split at playhead, and delete clips. |
| TL-03 | P0 | Scrub/playhead seek and visible time ruler with zoom controls. |
| TL-04 | P0 | Clips retain precise source in/out, timeline start, and duration values. |
| TL-05 | P0 | Edits update the preview and serialized project state consistently. |
| TL-06 | P0 | Undo/redo for common editing operations. |
| TL-07 | P1 | Snapping to playhead, clip edges, and timeline start. |
| TL-08 | P1 | Layer ordering, clip overlap, mute/visibility, and track locking. |
| TL-09 | P1 | Copy/paste and duplicate clips. |
| TL-10 | P1 | Frame-aware positioning using a documented timebase. |
| TL-11 | P2 | Ripple editing, multiselect, and grouped clips. |

Timeline semantics must be explicit. An overlap on the same track must have deterministic behavior; overlapping tracks must composite in a defined order. Splitting must preserve the source-time mapping and avoid introducing unintended gaps or duplicate frames.

### 4.5 Preview and playback

| ID | Priority | Requirement |
|---|---|---|
| PREV-01 | P0 | Canvas or equivalent composition preview that reflects clip timing, transforms, titles, and track order. |
| PREV-02 | P0 | Play, pause, seek, and visible current time/duration. |
| PREV-03 | P0 | Preview and export use the same canonical project model and compatible render semantics. |
| PREV-04 | P1 | Audio/video sync with reasonable behavior under normal browser load. |
| PREV-05 | P1 | Aspect ratio presets: 16:9, 9:16, and 1:1. |
| PREV-06 | P1 | Playback quality or resolution controls if necessary for performance. |
| PREV-07 | P2 | Fullscreen preview and safe-area guides. |

A preview that only displays the currently selected raw source clip, rather than the composed timeline, is insufficient.

### 4.6 Titles, overlays, transitions, and effects

| ID | Priority | Requirement |
|---|---|---|
| FX-01 | P0 | Add and edit text overlays with font size, color, position, and time range. |
| FX-02 | P0 | Position, scale, and crop/fit visual clips in the project frame. |
| FX-03 | P1 | Fade-in/out for video and audio. |
| FX-04 | P1 | At least two transitions (e.g., dissolve and wipe) with editable duration. |
| FX-05 | P1 | Basic brightness, contrast, and saturation adjustments. |
| FX-06 | P1 | Playback speed adjustments, with documented audio behavior. |
| FX-07 | P2 | Keyframes for transform and opacity. |
| FX-08 | P2 | Presets for title animations and lower thirds. |

### 4.7 Audio editing

| ID | Priority | Requirement |
|---|---|---|
| AUD-01 | P0 | Audio tracks are mixed into preview and exported file. |
| AUD-02 | P0 | Clip volume, mute, trim, and positioning. |
| AUD-03 | P1 | Audio fade-in/out and simple gain automation. |
| AUD-04 | P1 | Waveform display. |
| AUD-05 | P1 | Avoid clipping through reasonable gain handling or documented mixing policy. |
| AUD-06 | P2 | Audio ducking under spoken dialogue. |

### 4.8 AI-assisted editing

AI features must be grounded in actual project content and must produce verifiable output. They may use external APIs with provided keys. AI functionality must degrade gracefully when a provider is not configured.

| ID | Priority | Requirement |
|---|---|---|
| AI-01 | P0 | Transcribe speech from imported video/audio into timestamped text using a real transcription service or functional local model. |
| AI-02 | P0 | Convert timestamped transcript segments into editable caption overlays. |
| AI-03 | P0 | Burn approved captions into exported video. |
| AI-04 | P1 | Natural-language editing assistant produces a validated, structured edit plan. |
| AI-05 | P1 | Show proposed changes before applying; require confirmation for destructive edits. |
| AI-06 | P1 | Apply supported edits through the same command/state layer as manual editing, with undo. |
| AI-07 | P1 | Handle unsupported requests honestly and without fabricating changes. |
| AI-08 | P1 | Record per-operation status, latency, and estimated/actual provider usage cost where available. |
| AI-09 | P2 | Transcript-based removal of filler words or silence with previewable cut proposals. |
| AI-10 | P2 | Auto-generate social-media aspect-ratio variants with editable framing. |

**Structured edit action examples:** `addText`, `moveClip`, `trimClip`, `setVolume`, `addFade`, `createCaptions`. Validate action schema, target IDs, duration bounds, track permissions, and project ownership before applying.

The assistant must not execute arbitrary shell commands or code based on a user's natural-language prompt. Prompt content from media/transcripts is untrusted input.

### 4.9 Export and rendering

| ID | Priority | Requirement |
|---|---|---|
| EXP-01 | P0 | Export an actual playable MP4 with H.264 video and AAC audio, subject to supported runtime capabilities. |
| EXP-02 | P0 | Export respects trim, split, placement, layer order, titles, and audio mix. |
| EXP-03 | P0 | Download exported file through an authenticated or appropriately scoped URL. |
| EXP-04 | P0 | Report export progress and terminal success/failure status. |
| EXP-05 | P1 | 720p and 1080p export presets; 30 fps minimum target. |
| EXP-06 | P1 | Export honors captions, supported transitions, effects, and aspect ratio. |
| EXP-07 | P1 | Retry failed export without corrupting the saved project. |
| EXP-08 | P1 | Persist export history and downloadable artifacts for signed-in users. |
| EXP-09 | P2 | Background job queue with resumable status and concurrency limits. |

**Important deployment constraint:** Cloudflare Workers are not general-purpose long-running video-encoding hosts. The agent must select and document a technically viable export architecture. Acceptable approaches include browser-side WebCodecs/FFmpeg WASM (with realistic browser/memory limits) or an external rendering service/worker with asynchronous job orchestration. Do not claim Cloudflare Workers alone provide unrestricted native FFmpeg rendering. A backend-only export architecture must include its deployable runtime and actual configuration, not an unimplemented placeholder.

**No silent fallback:** If H.264/AAC MP4 export is not supported by the chosen runtime, expose the limitation, implement a truthful alternative where useful, and mark EXP-01 failed rather than renaming a WebM file to `.mp4`.

### 4.10 Persistence and collaboration readiness

| ID | Priority | Requirement |
|---|---|---|
| DATA-01 | P0 | Save canonical project data with versioned schema. |
| DATA-02 | P0 | Reopen a saved project with timeline and edit settings intact. |
| DATA-03 | P0 | Persist asset references without leaking cross-user access. |
| DATA-04 | P1 | Autosave with visible status and conflict-safe writes. |
| DATA-05 | P1 | Migration strategy for project schema changes. |
| DATA-06 | P1 | Project duplicate and rename. |
| DATA-07 | P2 | Revision history and restore. |
| DATA-08 | P2 | Collaboration-ready architecture; real-time multiuser editing is not required. |

### 4.11 Administration and operations

| ID | Priority | Requirement |
|---|---|---|
| OPS-01 | P0 | `/api/health` or equivalent reports service health without exposing secrets. |
| OPS-02 | P1 | Admin-only overview of registered users, project counts, storage use, exports, and AI usage/cost estimates. |
| OPS-03 | P1 | Date-range filtering for operational metrics (last hour, day, 3 days, 7 days). |
| OPS-04 | P1 | Structured logs and traceable request/job IDs for failed operations. |
| OPS-05 | P1 | Document quotas and abuse controls for uploads, AI calls, and rendering. |

---

## 5. Architecture and technology constraints

### 5.1 Required deployment environment

- Frontend and primary HTTP API must deploy to **Cloudflare Workers/Pages** using supported tooling.
- Prefer Cloudflare-native services when appropriate: **D1** for relational metadata, **R2** for assets/exports, **Queues** for asynchronous coordination, and **Durable Objects** only when justified.
- Use TypeScript for the main application and API unless a different language is necessary for a documented technical reason.
- A modern component framework is permitted (React is a reasonable default).
- An external rendering compute service is allowed only when necessary and must be explicitly documented, deployed, and configured for reproducibility. Do not assume such a service is available unless credentials and infrastructure are supplied.
- Use documented, maintained libraries; using FFmpeg, codecs, UI primitives, and general-purpose media libraries is allowed. **Do not embed, fork, or white-label a complete existing video editor as the solution.**
- No platform-specific agent rule files, hidden agent coaching, or extra instructions should be introduced to give one agent an advantage.

### 5.2 Recommended logical components (not mandatory file structure)

1. **Editor UI:** asset browser, canvas, timeline, properties inspector, AI panel, export panel.
2. **Canonical project model:** tracks, clips, source in/out, effects, overlays, captions, timebase, version.
3. **Edit command layer:** validated operations, undo/redo, autosave integration.
4. **Preview engine:** timeline evaluation, compositing, synchronized audio/video playback.
5. **Media service:** uploads, metadata, storage, signed asset access, thumbnails.
6. **AI service:** OpenAI-backed transcription and structured edit planning, validation, cost/usage accounting.
7. **Render service:** export plan, rendering/encoding, job state, artifact delivery.
8. **Persistence/API:** identity, projects, assets, authorization, exports, audit metadata.
9. **Operations:** health, logging, quotas, metrics, administration.

### 5.3 Canonical time model

Choose and document a consistent timebase (e.g., integer microseconds or rational frame positions). Avoid accumulating floating-point drift across many edits. Explicitly define inclusive/exclusive trim boundaries, clip duration, transition overlap, and export frame mapping. Keep the project schema independent from specific UI components.

### 5.4 Example project representation (illustrative, not prescriptive)

```json
{
  "schemaVersion": 1,
  "projectId": "project-123",
  "name": "My Short",
  "video": { "width": 1920, "height": 1080, "fps": 30 },
  "tracks": [
    {
      "id": "v1",
      "type": "video",
      "clips": [
        {
          "id": "clip-1",
          "assetId": "asset-1",
          "timelineStartUs": 0,
          "sourceStartUs": 2000000,
          "durationUs": 8000000,
          "transform": { "x": 0, "y": 0, "scale": 1 },
          "effects": []
        }
      ]
    }
  ]
}
```

The actual schema must also represent audio, captions, transitions, overlays, and other implemented features, and must be validated on read/write.

### 5.5 API expectations

Provide documented endpoints or equivalent RPC actions for authentication, projects, assets, AI tasks, export jobs, and health. All mutating operations must validate input and ownership. Upload and export endpoints must not expose unrestricted public buckets. Asynchronous operations must have inspectable states (`queued`, `running`, `completed`, `failed`, optionally `canceled`) and actionable error messages.

### 5.6 Security and privacy

- Store secrets in platform secret storage or local untracked environment files, never in source control or frontend bundles.
- Provide `.env.example` / `.dev.vars.example` with names only, no real credentials.
- Apply authentication, authorization, validation, content-type/file-size enforcement, and rate limits.
- Use signed URLs or authenticated streaming where appropriate for private media.
- Protect against path traversal, script injection in titles/captions, unsafe HTML rendering, and IDOR/cross-tenant data access.
- Minimize exposure of uploaded footage/transcripts to AI providers; document which services receive media or text.
- Implement sensible retention/deletion behavior and disclose provider processing limitations.
- Never log passwords, API keys, raw access tokens, or full private transcripts.

---

## 6. Environment configuration

Use environment variables for all environment-dependent settings. Exact service choices may vary; record deviations.

| Variable | Purpose |
|---|---|
| `APP_PUBLIC_URL` | Public application base URL, including scheme. |
| `APP_PUBLIC_HOSTNAME` | Expected public hostname where needed. |
| `DATABASE_URL` or D1 binding | Metadata storage connection/binding. |
| `MEDIA_BUCKET` or R2 binding | Media and export object storage. |
| `SESSION_SECRET` | Session signing/encryption secret if applicable. |
| `OPENAI_API_KEY` | Existing user-supplied OpenAI API key for both editing and transcription; secret, server-side only. |
| `OPENAI_MODEL` | OpenAI model for structured edit planning (default `gpt-4o-mini`; configurable). |
| `OPENAI_TRANSCRIPTION_MODEL` | OpenAI speech-to-text model (default `whisper-1`; configurable). |
| `RENDER_SERVICE_URL` | External rendering endpoint, if used. |
| `RENDER_SERVICE_TOKEN` | Render-service authentication, if used. |
| `EMAIL_FROM` | Transactional email sender, if used. |
| `ADMIN_EMAILS` | Explicit initial admin allowlist, if used. |

### 6.1 Mandatory OpenAI integration (same credentials for all agents)

- **OpenAI is the required runtime AI provider.** Use the existing `OPENAI_API_KEY` supplied in the environment. Do not create new OpenAI accounts, projects, API keys, or paid subscriptions.
- Use `OPENAI_MODEL` (default `gpt-4o-mini`) for natural-language editing plans and structured tool/function calls. The model must output validated, typed edit operations that the application previews for user approval before applying. Never execute unvalidated model-generated code or shell commands.
- Use `OPENAI_TRANSCRIPTION_MODEL` (default `whisper-1`) for speech transcription and timestamped caption segments. Preserve usable segment/word timing where supported by the selected model; verify timing against actual media. If the configured model lacks required timestamp granularity, document the limitation or implement a documented alignment step.
- Keep model identifiers configurable so supported models can be substituted without changing source code. Do not silently switch providers.
- OpenAI API requests must originate from a trusted server-side boundary (Cloudflare Worker/API or authorized backend), never directly from a browser containing the key. Apply authentication/authorization, usage limits, timeout/retry handling, and request-size limits.
- In local development, load `OPENAI_API_KEY` from an untracked `.dev.vars` file (or equivalent secure local environment configuration). Commit only `.dev.vars.example` with placeholder values; add `.dev.vars`, `.env`, and other secret-bearing files to `.gitignore`.
- For production, provision `OPENAI_API_KEY` as a **Cloudflare Worker secret** (e.g. `wrangler secret put OPENAI_API_KEY`) or the equivalent secret facility for the deployed runtime. Never place the key in `wrangler.toml`, `wrangler.jsonc`, source files, logs, build output, public variables, or frontend assets.
- The agent may use already-provisioned credentials and approved secret-injection mechanisms. If interactive secret provisioning requires human action, request it rather than printing, copying, or exposing the key. Do not claim the secret was deployed unless verified safely.
- Verify OpenAI integration with **real** authenticated requests: (1) a transcription that produces usable timed captions from test speech, and (2) an editing instruction that generates valid operations, applies them to a project after confirmation, and supports undo. Automated tests may mock the API but do not replace these end-to-end checks.
- Track approximate token/transcription usage and cost when provider usage data is available, without logging private transcript content or credentials. Include provider/model names and observed integration results in `BUILD_REPORT.md`.
- `/api/health` may report a boolean `openaiConfigured` derived from server-side configuration, but must never return the key or sensitive configuration values. Configuration alone is not proof that requests succeed.

### 6.2 Cloudflare deployment verification

- Deploy the frontend and primary API to the assigned Cloudflare environment; create/bind necessary D1, R2, and other resources and apply migrations when authorized. Use the supplied project-specific hostname if one is configured; never hard-code a hostname from another agent's run.
- Document the exact Wrangler build/deploy commands, bindings, secrets **by name only**, and any manual steps or permission blockers.
- After deployment, verify the live public URL, `/api/health`, authenticated project persistence, a media upload, and both OpenAI-powered workflows against the deployed environment (not only local development). Record pass/fail evidence and distinguish missing permissions from implementation defects.
- Any video-rendering compute outside Cloudflare must be explicitly configured and tested, not assumed to be available.

If credentials are unavailable, implement clean configuration checks, keep unaffected workflows usable, and list blocked capabilities in the report. Do not fabricate service responses for production functionality. Local test mocks are permitted only within automated tests.

---

## 7. Design and UX acceptance

The editor should resemble a serious creative tool while remaining understandable to a new user.

**Desktop layout recommendation:** left asset library, central preview, right inspector/AI panel, bottom timeline, top project/export controls. Alternative layouts are permitted if they support the same workflows.

Required UX characteristics:

- Clear affordances for add, drag, trim, split, delete, play, save, and export.
- Visible selection state, playhead, current time, timeline scale, and active tool.
- Precise editing inputs in the inspector, not only drag gestures.
- Accessible labels, focus states, keyboard operability for core actions, and sufficient contrast.
- Nonblocking progress indicators for uploads, AI tasks, and exports.
- Undo/redo and confirmation for destructive actions.
- Meaningful errors with retry guidance; avoid silent failures and fake success toasts.
- Reasonable performance on a modern desktop browser with a 30–60 second, multi-clip project.

---

## 8. Reference evaluation workload

The evaluation team will provide a small, rights-cleared media pack to every agent after implementation. Agents may create their own synthetic fixtures for development, but must not rely on hard-coded filenames or expected evaluation media.

### 8.1 Media pack characteristics

- Three MP4 clips of different durations, totaling approximately 45–90 seconds, including at least one spoken segment.
- One MP3 background music track, 30–90 seconds long.
- One PNG image/logo.
- At least two video resolutions or aspect ratios.
- One clip with audio and one without.
- Optional corrupted/unsupported file for negative testing.

### 8.2 Final editing task

1. Create a new 1920×1080, 30 fps project.
2. Import all supplied assets.
3. Place three clips in a defined sequence and trim them to a **30-second finished timeline**.
4. Add a visible opening title for the first three seconds.
5. Add a fade or dissolve transition between two adjacent clips.
6. Add background music and reduce its volume beneath dialogue.
7. Transcribe the spoken section, correct at least one caption, and burn captions into the export.
8. Save the project, close/reload the editor, and verify edits persist.
9. Export a 1080p MP4 with audio and inspect the actual file.
10. Make one additional edit and export a second version.

If the final application lacks an element, the tester records failure rather than changing the task to match the implementation.

### 8.3 Export verification

Validate output using playback and metadata inspection (e.g., `ffprobe` where available): container/codec, resolution, frame rate, duration tolerance, audio presence, and correct visible edits. Inspect at least the beginning, middle, and end of the exported file. An export job reporting “completed” is not sufficient proof.

---

## 9. Test and quality requirements

### 9.1 Automated tests

Implement meaningful automated coverage, with particular attention to:

- Timeline time calculations: move, trim, split, overlap, source offsets, duration.
- Undo/redo command reversibility.
- Project serialization and rehydration.
- Validation and authorization boundaries.
- AI structured-action schema validation and rejected unsafe actions.
- Export-plan generation and renderer consistency where testable.
- API error handling and job state transitions.

### 9.2 End-to-end tests

At minimum, automate or explicitly execute these workflows:

- Guest opens editor and creates project.
- Registered user saves and reopens project.
- Upload and place video/audio media.
- Trim and split clips, then undo/redo.
- Add title and see it in preview.
- Start export and download the result.
- Attempt cross-user project access and verify denial.
- AI transcription/editing if credentials are configured.

### 9.3 Quality gates

Run and report the exact commands and results for lint, typecheck, unit tests, build, integration/e2e tests, and deployment smoke tests. Fix failing checks where possible. Do not remove meaningful tests merely to make the suite green. Identify skipped tests and explain why.

### 9.4 Performance and reliability targets

Targets for the evaluation environment (not guarantees):

- Initial editor interaction within 5 seconds on a modern desktop and normal broadband after cached dependencies are available.
- Scrubbing a small project should feel interactive; report notable delays.
- Autosave must not silently discard edits.
- Upload/export failures must not corrupt the project.
- Export processing must have timeouts, status visibility, and bounded resource consumption.

Document actual observed performance rather than claiming these targets were met without measurement.

---

## 10. Implementation strategy and time management

The agent controls implementation order, but should protect the end-to-end editing path before adding advanced polish.

**Suggested schedule (not a forced agent workflow):**

| Elapsed time | Recommended focus | Expected checkpoint |
|---|---|---|
| 0:00–0:30 | Inspect environment, plan architecture, identify rendering feasibility | Clear approach and risks |
| 0:30–2:00 | App shell, auth, storage, project schema, media import | Persisted project with uploaded assets |
| 2:00–4:00 | Timeline, preview, editing commands, text/audio | Usable edit and preview |
| 4:00–5:30 | Real MP4 export, verify output, fix render mismatches | Downloadable valid output |
| 5:30–6:30 | Transcription, captions, AI edit plans | At least one working AI flow |
| 6:30–7:30 | End-to-end tests, deployment, failure recovery | Deployed, tested application |
| 7:30–8:00 | Highest-value fixes and complete build report | Honest final handoff |

This schedule is guidance only. A difficult export architecture may justify moving export work earlier. The agent should make pragmatic tradeoffs and preserve working functionality.

---

## 11. Mandatory deliverables

By the end of the eight-hour run, provide:

1. **Source repository** with reproducible setup instructions and a clear license for agent-created code.
2. **Deployed application URL** and health endpoint, if deployment credentials permit.
3. **README.md** with architecture summary, setup, environment variables (including `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_TRANSCRIPTION_MODEL`), local development, tests, deployment, and supported browser/runtime limitations.
4. **BUILD_REPORT.md** with the mandatory sections in §12.
5. **FEATURE_MATRIX.md** listing each requirement ID as `implemented`, `partial`, `not implemented`, or `blocked`, with evidence or explanation.
6. **TEST_RESULTS.md** containing actual commands, results, skipped tests, and known failures.
7. **Example project or reproducible sample data** using rights-cleared or generated assets, when practical.
8. **Database migrations and infrastructure configuration** needed to reproduce the deployment.

Never include credentials, private keys, real user media, or unlicensed copyrighted media in the repository.

---

## 12. Mandatory `BUILD_REPORT.md` format

The report must be factual, self-contained, and written before the run ends.

### 12.1 Executive summary

- What was built and what genuinely works.
- Deployment URL and source commit SHA.
- Major accomplishments and limitations.
- Whether a real MP4 export was successfully generated and inspected.

### 12.2 Architecture

- Technology stack and rationale.
- Major components and data flow.
- Canonical timeline model and timebase.
- Preview/render consistency strategy.
- Storage, authentication, background processing, and OpenAI integration design (configured model names; never the secret value).
- External dependencies and their operational implications.

### 12.3 Implementation chronology

- Approximate timestamps for first runnable app, first uploaded asset, first timeline edit, first successful preview, first successful export, first AI feature, and final deployment.
- Major blockers and recovery actions.
- Human approvals or interventions, with reason and duration where known.

### 12.4 Feature status

- Link to `FEATURE_MATRIX.md`.
- Explain partial or missing P0/P1 features.
- Distinguish implemented-and-tested from implemented-but-unverified.

### 12.5 Verification

- Exact test commands and outcomes.
- End-to-end workflows actually exercised.
- Export metadata and playback verification.
- Screenshots or artifacts when available.
- Known bugs and reproduction steps.

### 12.6 Security and operational readiness

- Authorization, input validation, storage access, rate limiting, secrets handling.
- Deployment status, resource configuration, and known reliability limits.
- AI usage/cost controls and media privacy considerations.

### 12.7 Cost and resource usage

- Available API usage and estimated spend for AI/transcription.
- Storage and rendering resource assumptions.
- Any measured cost figures versus estimates.

### 12.8 Decisions and tradeoffs

- Important architectural decisions and alternatives rejected.
- Features deferred due to time or missing infrastructure.
- What would be required to reach production quality.

### 12.9 Next steps

- Prioritized fixes and remaining feature work.
- Top three technical risks.
- Recommended next milestone if development continued.

**Do not claim completion of tests, exports, or deployments that were not performed.** Include failed attempts and unresolved issues.

---

## 13. Evaluation rubric (100 points)

The evaluation team will independently score the finished product using the same media and tasks for all agents. Agent self-reports are evidence, not the final score.

| Category | Points | Evaluation basis |
|---|---:|---|
| End-to-end editing and export | 30 | Valid edited MP4, matching timeline, audio, captions, real playback |
| Timeline and preview correctness | 20 | Trim/split/move, multiple tracks, sync, undo/redo, consistent rendering |
| Product usability and design | 15 | Workflow clarity, interaction quality, responsiveness, accessibility |
| AI capabilities | 10 | Real transcription, editable captions, validated natural-language edits |
| Persistence and backend reliability | 10 | Save/reopen, media ownership, auth, failure recovery |
| Engineering quality | 10 | Architecture, tests, security, maintainability, deployment |
| Agent autonomy and reporting | 5 | Uninterrupted execution, honest reports, reproducible evidence |
| **Total** | **100** | |

### 13.1 Hard-failure flags

Report these separately even if the overall score is high:

- No real playable exported video.
- Preview does not reflect timeline composition.
- Project cannot be saved and reopened.
- Cross-user access to private projects/media is possible.
- Claimed AI feature is only a fake UI or canned response.
- Deployed URL is broken or deployment was not attempted despite working credentials.

### 13.2 Experiment metrics

Record per agent: wall-clock duration, number of approval prompts, number of human interventions, first UI time, first successful export time, deployment status, requirement completion counts, automated test outcomes, code changes/commit SHA, and API/cloud costs where measurable.

**Fairness note:** Count human approvals separately from coding quality. A tool's default permission behavior may differ; report both raw prompts and whether an explicit comparable approval policy was used.

---

## 14. Acceptance checklist

A submission reaches **core product acceptance** only if all the following can be demonstrated:

- [ ] Application starts and provides a usable editor.
- [ ] A user can import multiple video clips and audio.
- [ ] At least two visual and two audio tracks are supported.
- [ ] Clips can be placed, moved, trimmed, split, and deleted.
- [ ] Preview represents the composed timeline.
- [ ] A text title appears in preview and export.
- [ ] Audio is mixed into export at the intended timing and volume.
- [ ] A valid MP4 with H.264 video and AAC audio is produced and inspected.
- [ ] A project saves and reopens with edits intact.
- [ ] Registration/login works and user projects are access-controlled.
- [ ] OpenAI transcription creates editable timed captions and they appear in export.
- [ ] OpenAI natural-language editing produces validated operations, supports confirmation and undo, and works in the deployed environment.
- [ ] Error states are visible and failures do not silently corrupt projects.
- [ ] The application is deployed or deployment blocker is documented with evidence.
- [ ] `BUILD_REPORT.md`, `FEATURE_MATRIX.md`, and `TEST_RESULTS.md` are complete and truthful.

P1 and P2 features improve the score, but do not substitute for missing core acceptance items.

---

## 15. Out of scope / prohibited shortcuts

- No requirement for native desktop applications, mobile apps, or real-time multiplayer editing.
- No requirement to implement codecs from scratch.
- No need for payment processing or subscription billing in this experiment.
- No need for generative video creation or synthetic actors.
- No need to support every browser or codec; document supported configurations.
- Do not rely on hard-coded demo assets, canned AI output, fake export progress, or fabricated screenshots as evidence.
- Do not bypass Cloudflare/service permissions or weaken authentication to make deployment easier.
- Do not claim a third-party complete editor as an original implementation.
- Do not spend time on branding at the expense of functional editing and export.

---

## 16. Final agent instruction

**You have eight hours to build the strongest working AI-powered browser video editor you can.** Make decisions autonomously, prioritize the complete edit-preview-save-export workflow, and validate real behavior. Once the first implementation runs, continue testing and improving it. Keep the repository and deployment reproducible, protect credentials and user media, and provide an accurate final report. The evaluator will use the application, inspect exported video, and test features rather than relying on your description of them.
