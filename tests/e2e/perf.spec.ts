/** Preview playback performance on a multi-clip, multi-track project (informational thresholds). */
import { test, expect } from '@playwright/test';
import { startAsGuest, createProject, uploadFixtures, addAsset } from './helpers';

test('preview plays a 10-clip, 3-track project at interactive frame rates', async ({ page }) => {
  test.setTimeout(120_000);
  await startAsGuest(page);
  await createProject(page, 'Perf');
  await uploadFixtures(page, ['clip-a-speech-720p.mp4', 'clip-b-silent-1080p.mp4', 'music.mp3', 'logo.png']);
  for (let i = 0; i < 4; i++) await addAsset(page, i % 2 ? 'clip-b-silent-1080p.mp4' : 'clip-a-speech-720p.mp4');
  await addAsset(page, 'music.mp3');
  await addAsset(page, 'logo.png');
  for (let i = 0; i < 4; i++) {
    await page.getByTestId('text-tab').click();
    await page.getByTestId('add-title').click();
  }
  await expect(page.getByTestId('clip')).toHaveCount(10);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Home');
  const t0 = Date.now();
  await page.evaluate(() => {
    (globalThis as { __ffPreviewStats?: unknown }).__ffPreviewStats = { frames: 0, drawMs: 0 };
    (globalThis as { __ffSyncStats?: unknown }).__ffSyncStats = { samples: 0, sumMs: 0, maxMs: 0, signedMs: 0 };
  });
  await page.getByTestId('play').click();
  await page.waitForTimeout(5000);
  await page.getByTestId('play').click();
  const stats = await page.evaluate(() => (globalThis as { __ffPreviewStats?: { frames: number; drawMs: number } }).__ffPreviewStats!);
  const secs = (Date.now() - t0) / 1000;
  const fps = stats.frames / 5;
  console.log(`[perf] preview ${fps.toFixed(1)} fps, avg draw ${(stats.drawMs / Math.max(1, stats.frames)).toFixed(2)} ms over ${secs.toFixed(1)}s`);
  expect(fps).toBeGreaterThan(20);
  const sync = await page.evaluate(() => (globalThis as { __ffSyncStats?: { samples: number; sumMs: number; maxMs: number; signedMs: number } }).__ffSyncStats!);
  const avg = sync.sumMs / Math.max(1, sync.samples);
  console.log(`[perf] A/V sync: ${sync.samples} samples, avg |drift| ${avg.toFixed(1)} ms (signed ${(sync.signedMs / Math.max(1, sync.samples)).toFixed(1)} ms, + = video ahead), max ${sync.maxMs.toFixed(1)} ms`);
  expect(sync.samples).toBeGreaterThan(50);
  expect(avg).toBeLessThan(80);
  // Scrubbing: 20 seeks across the timeline settle quickly.
  const s0 = Date.now();
  for (let i = 0; i < 20; i++) await page.getByTestId('ruler').click({ position: { x: 20 + i * 30, y: 10 } });
  console.log(`[perf] 20 scrub clicks in ${Date.now() - s0} ms`);
});
