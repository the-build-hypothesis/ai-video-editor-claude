/**
 * Media compatibility: 1080p60 High-profile H.264 with B-frames + 44.1 kHz audio, and phone-style
 * rotation metadata. Preview and export must agree on orientation (rotated clip is portrait).
 */
import { test, expect } from '@playwright/test';
import { startAsGuest, createProject, uploadFixtures, addAsset, saveArtifact, ffprobe, frameRegionColor, canvasColor, meanVolume } from './helpers';

test.setTimeout(240_000);

test('B-frame 60fps and rotated phone footage preview/export consistently', async ({ page }) => {
  await startAsGuest(page);
  await createProject(page, 'Compat');
  await uploadFixtures(page, ['clip-e-1080p60-bframes.mp4', 'clip-d-rotated-phone.mp4']);
  // Rotated asset reports display dimensions (portrait).
  await expect(page.locator('[data-testid="asset"][data-asset-name="clip-d-rotated-phone.mp4"]')).toContainText('720×1280');
  await addAsset(page, 'clip-e-1080p60-bframes.mp4');
  await addAsset(page, 'clip-d-rotated-phone.mp4'); // [4s, 10s)

  // Preview at 7s: portrait clip letterboxed → left edge black, center colorful.
  await page.keyboard.press('Escape');
  await page.getByTestId('ruler').click({ position: { x: 7 * 60, y: 10 } });
  await expect.poll(async () => { const c = await canvasColor(page, 0.45, 0.4, 0.1, 0.2); return c.r + c.g + c.b; }, { timeout: 20_000 }).toBeGreaterThan(150);
  const edge = await canvasColor(page, 0.02, 0.3, 0.1, 0.4);
  expect(edge.r + edge.g + edge.b).toBeLessThan(20);

  await page.getByTestId('open-export').click();
  await page.getByTestId('export-preset').selectOption('720p');
  await page.getByTestId('start-export').click();
  await expect(page.locator('[data-testid="export-item"][data-status="completed"]').first()).toBeVisible({ timeout: 200_000 });
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-export').first().click()]);
  const file = saveArtifact('compat-export.mp4', Buffer.alloc(0));
  await d.saveAs(file);
  const p = ffprobe(file);
  expect(Math.abs(parseFloat(p.format.duration) - 10)).toBeLessThan(0.1);
  expect(p.streams.find((s) => s.codec_type === 'video')!.r_frame_rate).toBe('30/1');
  // Export at 7s: same orientation as preview.
  const eEdge = frameRegionColor(file, 7, { x: 10, y: 200, w: 120, h: 300 });
  const eCenter = frameRegionColor(file, 7, { x: 580, y: 250, w: 120, h: 200 });
  expect(eEdge.r + eEdge.g + eEdge.b).toBeLessThan(20);
  expect(eCenter.r + eCenter.g + eCenter.b).toBeGreaterThan(150);
  // 60fps source fully covers the frame at 2s; 44.1 kHz audio resampled and present.
  const full = frameRegionColor(file, 2, { x: 10, y: 200, w: 120, h: 300 });
  expect(full.r + full.g + full.b).toBeGreaterThan(100);
  expect(meanVolume(file, 1, 2)).toBeGreaterThan(-40);
});
