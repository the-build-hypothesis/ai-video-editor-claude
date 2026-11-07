/**
 * Journey A (first edit) + export verification + save/reload persistence.
 * Real browser, real local Worker (D1/R2 emulation), real WebCodecs encode; output inspected with ffprobe.
 */
import { test, expect } from '@playwright/test';
import { startAsGuest, createProject, uploadFixtures, addAsset, waitSaved, ffprobe, frameRegionColor, meanVolume, saveArtifact, canvasColor, trackConsole } from './helpers';

test.setTimeout(300_000);

test('guest edits, previews, saves, reloads and exports a valid MP4', async ({ page }) => {
  const errors = trackConsole(page);
  await startAsGuest(page);
  await createProject(page, 'E2E Journey A');

  // Import media (corrupt file must be rejected without breaking anything).
  await uploadFixtures(page, ['clip-a-speech-720p.mp4', 'clip-b-silent-1080p.mp4', 'music.mp3', 'logo.png']);
  await page.getByTestId('file-input').setInputFiles('fixtures/corrupt.mp4');
  await expect(page.locator('.upload-error-msg')).toContainText(/corrupt|not a readable/i, { timeout: 30_000 });

  // Arrange: clip A then clip B on V1, music on A1.
  await addAsset(page, 'clip-a-speech-720p.mp4');
  await addAsset(page, 'clip-b-silent-1080p.mp4');
  await addAsset(page, 'music.mp3');
  await expect(page.getByTestId('clip')).toHaveCount(3);

  // Trim clip B to 5s via the inspector (precise input).
  await page.locator('[data-clip-kind="video"]').nth(1).click();
  const dur = page.getByTestId('inspector').getByLabel('Duration');
  await dur.fill('5');
  await dur.press('Enter');
  // Trim music to end at the same time as video (12.657 + 5).
  await page.locator('[data-clip-kind="audio"]').click();
  const endField = page.getByTestId('inspector').getByLabel('End');
  await endField.fill('17.6');
  await endField.press('Enter');
  await page.getByTestId('inspector').getByLabel('Fade out').fill('2');
  await page.getByTestId('inspector').getByLabel('Fade out').press('Enter');

  // Split clip A at 6s, then undo + redo.
  await page.getByTestId('ruler').click({ position: { x: 6 * 60 + 1, y: 10 } });
  await page.locator('[data-clip-kind="video"]').first().click();
  await page.getByTestId('split').click();
  await expect(page.getByTestId('clip')).toHaveCount(4);
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('clip')).toHaveCount(3);
  await page.getByTestId('redo').click();
  await expect(page.getByTestId('clip')).toHaveCount(4);

  // Add a title at 0 for 3 seconds.
  await page.keyboard.press('Home');
  await page.getByTestId('text-tab').click();
  await page.getByTestId('add-title').click();
  await page.getByTestId('text-content').fill('HELLO E2E');
  await page.getByTestId('text-content').blur();
  await expect(page.locator('[data-clip-kind="text"]')).toHaveCount(1);

  // Preview shows the composed frame: at t=1s the testsrc2 clip (colorful) + title → not black.
  await page.keyboard.press('Escape');
  await page.getByTestId('ruler').click({ position: { x: 60 + 1, y: 10 } });
  await page.waitForTimeout(800);
  const c = await canvasColor(page, 0.05, 0.05, 0.2, 0.2);
  expect(c.r + c.g + c.b).toBeGreaterThan(60);
  await page.screenshot({ path: 'artifacts/e2e-editor.png' });

  // Play briefly: time advances.
  await page.getByTestId('play').click();
  await page.waitForTimeout(1500);
  await page.getByTestId('play').click();
  const t = await page.getByTestId('current-time').textContent();
  expect(t).not.toBe('00:01:00');

  // Save + reload persists the timeline.
  await waitSaved(page);
  await page.reload();
  await expect(page.getByTestId('clip')).toHaveCount(5);
  await expect(page.locator('[data-clip-kind="text"]')).toHaveCount(1);

  // Export 720p and verify the file.
  await page.getByTestId('open-export').click();
  await page.getByTestId('export-preset').selectOption('720p');
  await page.getByTestId('start-export').click();
  await expect(page.locator('[data-testid="export-item"][data-status="completed"]').first()).toBeVisible({ timeout: 240_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-export').first().click()]);
  const file = saveArtifact('e2e-export-720p.mp4', Buffer.alloc(0));
  await download.saveAs(file);
  const probe = ffprobe(file);
  const v = probe.streams.find((s) => s.codec_type === 'video')!;
  const a = probe.streams.find((s) => s.codec_type === 'audio')!;
  expect(probe.format.format_name).toContain('mp4');
  expect(v.codec_name).toBe('h264');
  expect(v.width).toBe(1280);
  expect(v.height).toBe(720);
  expect(v.r_frame_rate).toBe('30/1');
  expect(a.codec_name).toBe('aac');
  expect(Math.abs(parseFloat(probe.format.duration) - 17.66)).toBeLessThan(0.2);
  // Title visible at the start: centre region contains white text pixels → bright.
  const title = frameRegionColor(file, 1, { x: 440, y: 320, w: 400, h: 80 });
  expect(title.r + title.g + title.b).toBeGreaterThan(150);
  // Audio present in the speech section and music fades out at the end.
  expect(meanVolume(file, 1, 3)).toBeGreaterThan(-40);
  expect(meanVolume(file, 17.3, 0.3)).toBeLessThan(meanVolume(file, 13, 1));
  expect(errors.filter((e) => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});
