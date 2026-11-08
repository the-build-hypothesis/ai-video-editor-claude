/**
 * Journeys C (AI captions) and D (AI-directed edit) using REAL OpenAI calls through the Worker.
 * Skipped when SKIP_REAL_AI=1. Also verifies captions are burned into the exported MP4.
 */
import { test, expect } from '@playwright/test';
import { startAsGuest, createProject, uploadFixtures, addAsset, waitSaved, ffprobe, frameRegionColor, saveArtifact, trackConsole } from './helpers';

test.skip(!!process.env.SKIP_REAL_AI, 'real OpenAI calls disabled');
test.setTimeout(300_000);

test('transcribe → edit caption → AI edit plan → apply → undo → export with burned captions', async ({ page }) => {
  const errors = trackConsole(page);
  await startAsGuest(page);
  await createProject(page, 'E2E AI');
  await uploadFixtures(page, ['clip-a-speech-720p.mp4', 'music.mp3']);
  await addAsset(page, 'clip-a-speech-720p.mp4');
  await addAsset(page, 'music.mp3');

  // --- Journey C: captions
  await page.getByTestId('tab-captions').click();
  const sel = page.getByTestId('transcribe-clip');
  const value = await sel.locator('option', { hasText: 'clip-a-speech' }).getAttribute('value');
  await sel.selectOption(value!);
  await page.getByTestId('transcribe').click();
  await expect(page.getByTestId('caption-item').first()).toBeVisible({ timeout: 90_000 });
  const count = await page.getByTestId('caption-item').count();
  expect(count).toBeGreaterThan(1);
  const allText = (await page.getByTestId('caption-text').evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value).join(' '))).toLowerCase();
  expect(allText).toMatch(/caption|fox|demo/);
  // Punctuation restored from Whisper segments (word timings alone are unpunctuated).
  expect(allText).toMatch(/[.,!?]/);
  console.log('[captions]', allText.slice(0, 200));
  // Correct the first caption.
  const first = page.getByTestId('caption-text').first();
  await first.fill('CORRECTED CAPTION');
  await first.blur();
  await expect(page.locator('.caption-chip').first()).toHaveText('CORRECTED CAPTION');

  // --- Journey D: AI edit plan
  await page.getByTestId('tab-ai').click();
  await page.getByTestId('ai-instruction').fill('Add a title "AI TITLE" at the start for 3 seconds and fade the music out over the last 2 seconds.');
  await page.getByTestId('ai-submit').click();
  await expect(page.getByTestId('ai-plan')).toBeVisible({ timeout: 60_000 });
  const planText = await page.getByTestId('ai-plan').textContent();
  expect(planText).toMatch(/addText/);
  expect(planText).toMatch(/addFade/);
  await page.screenshot({ path: 'artifacts/e2e-ai-plan.png' });
  const before = await page.getByTestId('clip').count();
  // Plans that trim/delete require explicit confirmation of destructive changes.
  const confirmBox = page.getByTestId('ai-confirm-destructive');
  if (await confirmBox.count()) {
    await expect(page.getByTestId('ai-apply')).toBeDisabled();
    await confirmBox.check();
  }
  await page.getByTestId('ai-apply').click();
  await expect(page.locator('[data-clip-kind="text"]')).toHaveCount(1);
  expect(await page.getByTestId('clip').count()).toBe(before + 1);
  // Music clip got a fade-out (rendered as .fade-out overlay).
  await expect(page.locator('[data-clip-kind="audio"] .fade-out')).toHaveCount(1);
  // Undo removes the whole AI edit as one step; redo brings it back.
  await page.getByTestId('undo').click();
  await expect(page.locator('[data-clip-kind="text"]')).toHaveCount(0);
  await expect(page.locator('[data-clip-kind="audio"] .fade-out')).toHaveCount(0);
  await page.getByTestId('redo').click();
  await expect(page.locator('[data-clip-kind="text"]')).toHaveCount(1);

  // --- Export with burned-in captions
  await waitSaved(page);
  await page.getByTestId('open-export').click();
  await page.getByTestId('export-preset').selectOption('720p');
  await page.getByTestId('start-export').click();
  await expect(page.locator('[data-testid="export-item"][data-status="completed"]').first()).toBeVisible({ timeout: 240_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-export').first().click()]);
  const file = saveArtifact('e2e-ai-captions.mp4', Buffer.alloc(0));
  await download.saveAs(file);
  const probe = ffprobe(file);
  expect(probe.streams.map((s) => s.codec_name).sort()).toEqual(['aac', 'h264']);
  // Caption box (dark background, bottom area) present during speech: bottom-center region is darker
  // than the colorful test pattern alone would be. Compare a frame with captions to the known pattern.
  const capFrame = frameRegionColor(file, 4, { x: 340, y: 600, w: 600, h: 50 });
  expect(capFrame.r + capFrame.g + capFrame.b).toBeLessThan(500);
  expect(errors.filter((e) => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});
