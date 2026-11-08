# Test results

Environment:
- **Machine:** WSL2 Ubuntu 26.04, Node 26.13, Chromium 158 (Playwright headless shell).
- **Local server:** `vite dev` running the Worker in workerd with local D1, in D1-storage mode (`FF_STORAGE=d1`) to match production.
- **Production:** https://ai-video-editor-v1-claude.thebuildhypothesis.com
- **Inspection tools:** ffprobe 4.0.2 and ffmpeg 7.0.2 (static builds from devDependencies).

All results below come from runs during the build session (2026-11-07). The final re-run before handoff is recorded at the bottom.

## Quality gates

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ 0 errors |
| Lint | `npm run lint` | ✅ 0 errors, 3 warnings (`no-control-regex` on a filename sanitizer, `no-useless-assignment`, one `no-explicit-any` in a test) |
| Unit tests | `npm test` (vitest) | ✅ 10 files, **208 passed** |
| Build | `FF_STORAGE=d1 npm run build` | ✅ (client ~1.0 MB JS + 1.1 MB lazy AAC encoder chunk) |
| API + e2e (local) | `npx playwright test --workers=2` | ✅ **31 passed** (22 API + 9 browser), ~1.2 min |
| API + e2e (production) | `API_BASE_URL=https://… ADMIN_EMAIL=… ADMIN_PASSWORD=… npx playwright test tests/api tests/e2e/{account,edit-export,ai-captions,failure-recovery,silence,media-compat,a11y}.spec.ts` | ✅ 29 passed, then the a11y spec failed on one spinner-label issue; fixed, redeployed, re-run ✅ |
| §8.2 final task (production) | `API_BASE_URL=https://… npx playwright test tests/e2e/final-task.spec.ts` | ✅ passed on deployed version `634c4c01` (export+upload 78 s and 64 s) |

## Unit tests (vitest)

| File | Tests | Covers |
|---|---|---|
| `time.test.ts` | 48 | frame ↔ µs mapping at 24/25/30/50/60 fps, snapping, frame counts, no drift |
| `commands.test.ts` | 49 | add/move/trim/split/update/duplicate/paste/ripple/tracks/captions/ducking, locked tracks, plus 2×200 seeded random edit sequences that check schema validity, integer times and split coverage |
| `undo-serialization.test.ts` | 33 | JSON round trip, v1→v2 migration, newer/garbage schema rejected, store undo/redo semantics, command immutability on deep-frozen input for all commands |
| `timeline-eval.test.ts` | 27 | layer order, fades, transitions (dissolve, dip, wipe), speed mapping, caption boundaries, audio segment rules, gain automation, export plan (30 s @ 30 fps = 900 frames) |
| `ai-actions.test.ts` | 25 | plan schema rejects unknown/garbage ops; valid ops apply; unknown IDs, out-of-range values, locked tracks and missing transition predecessors are rejected; destructive flags; caption follow-up; untrusted transcript wrapping; JSON schema matches zod |
| `remove-ranges.test.ts` | 3 | silence cuts keep source mapping, ripple with no gaps, captions shift/remove, clamping |
| `worker-crypto/sniff/rules/plan.test.ts` | 23 | PBKDF2 hash/verify, magic-byte sniffing, job status transitions, rate-limit windows, admin ranges, cost estimates, plan parsing |

Bugs found by these tests and fixed: frame-count off-by-one (exports had a trailing extra frame), `usToFrame` boundary rounding, split dropping gain automation at the cut, image clip start-trim limit, and AI transition-predecessor tolerance not matching the renderer.

## API tests (`tests/api/api.spec.ts`, Playwright request context)

22 tests: health without secrets; JSON 404 with request id; register/login/logout/me; cookie flags; validation and duplicate email; generic wrong-password error; login rate limit (429 + Retry-After); guest flow and upgrade keeping projects; CSRF header requirement; project CRUD, 409 conflict, rename, duplicate, revisions and restore; asset upload (PNG and MP3), list, Range requests (206), thumbnail, patch; corrupt MP4, wrong type and oversize rejected; guest quota; export lifecycle and download; failed/canceled jobs can't complete; **cross-user isolation (404 on another user's project, asset, export and content)**; unauthenticated 401; admin 403 and 200 with metrics for all ranges; AI validation paths; **real OpenAI transcription** (whisper-1: 4 segments, 28 words, timestamps offset correctly); **real OpenAI plan** (gpt-4o-mini: valid `addText` op).

Production notes: the "different IP isn't rate-limited" assertion runs only locally, because the client IP can't be spoofed through Cloudflare. The admin check needs `ADMIN_EMAIL` and `ADMIN_PASSWORD` for the deployment's operator account.

## Browser e2e tests (`tests/e2e`, Chromium)

| Spec | What it does | Local | Prod |
|---|---|---|---|
| `edit-export.spec.ts` (Journey A) | guest → project → import (corrupt file rejected) → arrange → inspector trim → split, undo, redo → title → preview pixels → play → save/reload → **720p export, then ffprobe** (h264 1280×720 30/1, aac, 17.66 s ±0.2) + title pixels + audio level + music fade-out | ✅ | ✅ |
| `account.spec.ts` (Journey B + isolation) | register → edit → sign out → sign in → reopen → edit again → **second user gets "not found" + 404** | ✅ | ✅ |
| `ai-captions.spec.ts` (Journeys C + D) | **real** whisper transcription → captions → correct one → **real** gpt-4o-mini plan ("title + fade music") → review → confirm destructive → apply → undo/redo as one step → export → caption box pixels in MP4 | ✅ | ✅ |
| `final-task.spec.ts` (§8.2) | 1920×1080/30 project, 5 assets, 3 clips → 30 s, logo overlay, 3 s title, dissolve, music trimmed + 35% + fade + auto-duck, transcription + corrected caption, reload, **1080p export, then ffprobe** (h264 1920×1080 30/1, aac, 30.0 s ±0.15) + title/logo/caption pixels + audio levels, second edit, **second export** with changed title | ✅ | ✅ (v`634c4c01`) |
| `failure-recovery.spec.ts` (Journey E) | injected upload 500 → Retry succeeds; transcription 502 → error + Retry; plan 504 → error, nothing applied; export storage 500 → job failed + Retry → completed; reload intact. Plus a **two-tab autosave conflict** detected and resolved | ✅ | ✅ |
| `media-compat.spec.ts` | 1080p60 High profile with B-frames + 44.1 kHz audio, and a phone clip with 90° rotation metadata: preview and export orientation agree; duration and fps checked | ✅ | ✅ |
| `silence.spec.ts` | WAV import → find silences → 1 proposal → cut → clip split/rippled → undo | ✅ | ✅ |
| `a11y.spec.ts` | axe-core WCAG 2 A/AA on auth, dashboard and editor with all side tabs: 0 serious/critical violations | ✅ | ✅ (after spinner fix) |

## Export verification (actual files, kept in `artifacts/`, not committed)

`final-task-v1-1080p.mp4` (§8.2 run, local):
```
stream|codec_name=h264|profile=High|width=1920|height=1080|r_frame_rate=30/1|nb_frames=900
stream|codec_name=aac|profile=LC|nb_frames=1408   (48 kHz stereo)
format|duration=30.015990
```
Frames inspected at 1.5 s, 8 s, 12 s and 25 s:
- 1.5 s: title, letterboxed portrait clip, logo.
- 8 s: mid-dissolve blend of the two clips, with the corrected caption.
- 12 s: auto caption burned in.
- 25 s: the third clip, with the logo.

The source timecodes burned into the test pattern confirm the trim and split source mapping: timeline 6.5 s shows source 06.500 after a split at 6 s. Audio levels were checked with ffmpeg `volumedetect`: dialogue present; music lower under dialogue and fading to near-silence in the last 0.3 s.

`e2e-export-720p.mp4`: h264 High 1280×720 30 fps, 531 frames, AAC LC 48 kHz stereo, 17.71 s.

## Measured performance (Chromium headless, this machine)

- **1080p export of the 30 s §8.2 timeline:** 8–10 s render + encode locally (≈3× realtime). On production, export plus upload took 64–78 s, dominated by downloading the source media and uploading the 30 MB MP4 through D1-chunk storage.
- **Preview playback** (`perf.spec.ts`, 10 clips on 3 tracks): **60 fps**, about 2.1 ms per composited frame; 20 scrub seeks in under 0.7 s.
- **A/V sync:** the preview clock follows the *heard* audio (AudioContext time minus output latency). Video elements trail it by about 47 ms on average (max about 80 ms) in this headless, software-decoding Chromium, even with rate-based correction (±6%) and re-seeks above 120 ms. Real hardware decoding is expected to do better, but that wasn't measured here.
- **Initial editor load (local):** under 1 s to an interactive editor. On production the editor loads in about 2–3 s. Video frames for the first preview take about 2 s when the source MP4 keeps its index at the end of the file; the preview shows "Loading media…" meanwhile.
- **Transcription (whisper-1):** ≈5–10 s for 12.7 s of speech. **Plan (gpt-4o-mini):** ≈2–6 s.

## Skipped / not covered

- Tests that call OpenAI skip with `SKIP_REAL_AI=1`. They were **not** skipped in the recorded runs.
- No automated test for drag-and-drop gestures on the timeline (move/trim by mouse). Those code paths were exercised manually through screenshots; move and trim are tested through the inspector and commands.
- **Cross-browser:**
  - Chromium 158 (Linux) is fully tested.
  - **Firefox 159 (Playwright build, Linux)** has WebCodecs but no H.264 decode or encode, because Playwright's Firefox doesn't download OpenH264. There, the app rejects MP4 uploads with "This browser cannot decode H.264 video… use Chrome or Edge" and disables export with "cannot encode H.264… No fallback format is substituted". Verified by a scripted run. Image and audio import work.
  - Consumer Firefox and Safari were not tested. WebKit couldn't be launched in this environment (missing system libraries).
  - Chrome and Edge on Windows/macOS were not tested.
- Preview audio/video sync was checked by eye only; it isn't measured.

## Known failures / flakiness

- Early runs hit a test race where fields were filled before the inspector switched to the newly added clip, and once a hot-reload happened mid-test while another agent edited files. The helpers now wait for the inspector, and `NumField` commits read the live DOM value. No failures since.
- Production storage is the D1 fallback, so a capacity guard (`D1_MAX_DB_MB=450`) rejects new uploads with 507 `storage_full` once the database nears that size. Repeated full test runs against production consume this budget; see BUILD_REPORT.
