/**
 * Spec §8.2 "Final editing task", automated end to end against the running app (local or deployed):
 * 1080p/30 project, all media imported, 3 clips trimmed to a 30 s timeline, opening title (0–3 s),
 * dissolve between adjacent clips, background music lowered under dialogue, transcription + one
 * corrected caption burned in, save + reload, 1080p MP4 export inspected, one more edit + second export.
 * Uses real OpenAI transcription (skipped with SKIP_REAL_AI=1).
 */
import { test, expect, type Page } from '@playwright/test';
import { startAsGuest, createProject, uploadFixtures, addAsset, waitSaved, ffprobe, frameRegionColor, meanVolume, saveArtifact, trackConsole } from './helpers';

test.skip(!!process.env.SKIP_REAL_AI, 'needs real OpenAI transcription');
test.setTimeout(600_000);
test.use({ viewport: { width: 1920, height: 1080 }, actionTimeout: 20_000 });

const insp = (page: Page) => page.getByTestId('inspector');
async function setNum(page: Page, label: string, value: number) {
  // Commit, then confirm the committed value stuck (re-renders right after selecting a new clip
  // can occasionally swallow a value typed in the same tick; see BUILD_REPORT known issues).
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = insp(page).getByLabel(label, { exact: true });
    await f.fill(String(value));
    await f.press('Enter');
    await page.waitForTimeout(150);
    const v = parseFloat(await insp(page).getByLabel(label, { exact: true }).inputValue());
    if (Math.abs(v - value) < 0.01) return;
    console.log(`[setNum] retry ${label}=${value} (got ${v})`);
  }
  throw new Error(`could not set ${label} to ${value}`);
}
async function selectClip(page: Page, kind: string, nth = 0) {
  await page.locator(`[data-clip-kind="${kind}"]`).nth(nth).click({ position: { x: 20, y: 30 } });
}

async function exportAndDownload(page: Page, name: string, expectedCompleted: number) {
  await page.getByTestId('open-export').click();
  await page.getByTestId('export-preset').selectOption('1080p');
  const t0 = Date.now();
  await page.getByTestId('start-export').click();
  await expect(page.locator('[data-testid="export-item"][data-status="completed"]')).toHaveCount(expectedCompleted, { timeout: 400_000 });
  const seconds = (Date.now() - t0) / 1000;
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-export').first().click()]);
  const file = saveArtifact(name, Buffer.alloc(0));
  await download.saveAs(file);
  console.log(`[final-task] ${name}: export+upload took ${seconds.toFixed(1)}s`);
  return file;
}

test('§8.2 final editing task', async ({ page }) => {
  const errors = trackConsole(page);
  await startAsGuest(page);
  console.log('[step] 1. New 1920×1080 30 fps project');
  // 1. New 1920×1080 30 fps project
  await createProject(page, 'Final Task');
  await expect(page.getByText('1920×1080 · 30 fps')).toBeVisible();
  console.log('[step] 2. Import all assets');
  // 2. Import all assets
  await uploadFixtures(page, ['clip-c-portrait.mp4', 'clip-a-speech-720p.mp4', 'clip-b-silent-1080p.mp4', 'music.mp3', 'logo.png']);

  console.log('[step] 3. Three clips in sequence trimmed to a 30 s timeline: C [0,8) · A [8,20.657) · B [20.657,30)');
  // 3. Three clips in sequence trimmed to a 30 s timeline: C [0,8) · A [8,20.657) · B [20.657,30)
  await addAsset(page, 'clip-c-portrait.mp4');
  await setNum(page, 'Duration', 8);
  await addAsset(page, 'clip-a-speech-720p.mp4');
  await addAsset(page, 'clip-b-silent-1080p.mp4');
  await setNum(page, 'End', 30);
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(3);
  await expect(page.getByTestId('current-time').locator('..')).toContainText('00:30:00');

  // Logo overlay on V2 (top-right, half size) for the whole video.
  await addAsset(page, 'logo.png');
  await insp(page).getByTestId('clip-track').selectOption({ label: 'V2' });
  await setNum(page, 'Start', 0);
  await setNum(page, 'End', 30);
  await setNum(page, 'X', 800);
  await setNum(page, 'Y', -400);

  console.log('[step] 4. Opening title for the first three seconds');
  // 4. Opening title for the first three seconds
  await page.keyboard.press('Home');
  await page.getByTestId('text-tab').click();
  await page.getByTestId('add-title').click();
  await page.getByTestId('text-content').fill('FINAL TASK');
  await page.getByTestId('text-content').blur();
  await setNum(page, 'Duration', 3);

  console.log('[step] 5. Dissolve between clip C and clip A (1 s, centered on the cut at 8 s)');
  // 5. Dissolve between clip C and clip A (1 s, centered on the cut at 8 s)
  await selectClip(page, 'video', 1);
  await insp(page).getByTestId('transition-type').selectOption('dissolve');

  console.log('[step] 6. Background music, trimmed to 30 s, lowered beneath dialogue, fade out 2 s');
  // 6. Background music, trimmed to 30 s, lowered beneath dialogue, fade out 2 s
  await addAsset(page, 'music.mp3');
  await setNum(page, 'End', 30);
  await setNum(page, 'Fade out', 2);
  const vol = insp(page).getByLabel(/^Volume/);
  await vol.fill('0.35');
  await vol.blur();

  console.log('[step] 7. Transcribe the spoken clip, correct one caption, captions burned in');
  // 7. Transcribe the spoken clip, correct one caption, captions burned in
  await page.getByTestId('tab-captions').click();
  const sel = page.getByTestId('transcribe-clip');
  await sel.selectOption((await sel.locator('option', { hasText: 'clip-a-speech' }).getAttribute('value'))!);
  await page.getByTestId('transcribe').click();
  await expect(page.getByTestId('caption-item').first()).toBeVisible({ timeout: 120_000 });
  const firstCap = page.getByTestId('caption-text').first();
  await firstCap.fill('Welcome to the FINAL demo.');
  await firstCap.blur();
  await expect(page.getByTestId('burn-in')).toBeChecked();
  // Duck music further under dialogue using caption timing (AUD-06).
  await selectClip(page, 'audio');
  await page.getByTestId('tab-inspector').click();
  await insp(page).getByRole('button', { name: 'Auto-duck under dialogue' }).click();

  console.log('[step] 8. Save, reload, verify persistence');
  // 8. Save, reload, verify persistence
  await waitSaved(page);
  await page.screenshot({ path: 'artifacts/final-task-editor.png' });
  await page.reload();
  await expect(page.getByTestId('clip')).toHaveCount(6); // 3 video + logo + title + music
  await expect(page.locator('.caption-chip').first()).toHaveText('Welcome to the FINAL demo.');

  console.log('[step] 9. Export 1080p and inspect');
  // 9. Export 1080p and inspect
  const file1 = await exportAndDownload(page, 'final-task-v1-1080p.mp4', 1);
  const p1 = ffprobe(file1);
  const v = p1.streams.find((s) => s.codec_type === 'video')!;
  const a = p1.streams.find((s) => s.codec_type === 'audio')!;
  expect([v.codec_name, v.width, v.height, v.r_frame_rate]).toEqual(['h264', 1920, 1080, '30/1']);
  expect(a.codec_name).toBe('aac');
  expect(Math.abs(parseFloat(p1.format.duration) - 30)).toBeLessThan(0.15);
  // Title near center at 1 s (white text → bright).
  const t = frameRegionColor(file1, 1.5, { x: 760, y: 500, w: 400, h: 80 });
  expect(t.r + t.g + t.b).toBeGreaterThan(300);
  // Logo (blue #3355ff) top-right at mid-video.
  const logo = frameRegionColor(file1, 15, { x: 1700, y: 60, w: 40, h: 30 });
  expect(logo.b).toBeGreaterThan(200);
  expect(logo.r).toBeLessThan(120);
  // Captions box bottom-center during speech (~12 s).
  const cap = frameRegionColor(file1, 12, { x: 760, y: 950, w: 400, h: 40 });
  expect(cap.r + cap.g + cap.b).toBeLessThan(450);
  // Audio: dialogue section louder than the ducked-music-only end, music fades out at the end.
  expect(meanVolume(file1, 9, 3)).toBeGreaterThan(-35);
  expect(meanVolume(file1, 29.6, 0.3)).toBeLessThan(meanVolume(file1, 24, 2));

  console.log('[step] 10. One more edit (change title) and export a second version.');
  // 10. One more edit (change title) and export a second version.
  await page.locator('[data-clip-kind="text"]').click({ position: { x: 10, y: 20 } });
  await page.getByTestId('text-content').fill('VERSION TWO');
  await page.getByTestId('text-content').blur();
  await waitSaved(page);
  const file2 = await exportAndDownload(page, 'final-task-v2-1080p.mp4', 2);
  const p2 = ffprobe(file2);
  // The second version shows the new title text: compare title region with v1 (must differ).
  const t2 = frameRegionColor(file2, 1.5, { x: 760, y: 500, w: 400, h: 80 });
  expect(Math.abs(t2.r - t.r) + Math.abs(t2.g - t.g) + Math.abs(t2.b - t.b)).toBeGreaterThan(3);
  expect(Math.abs(parseFloat(p2.format.duration) - 30)).toBeLessThan(0.15);
  await expect(page.locator('[data-testid="export-item"][data-status="completed"]')).toHaveCount(2);
  expect(errors.filter((e) => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});
