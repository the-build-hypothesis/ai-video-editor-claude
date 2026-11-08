/** FX-07: keyframe animation (auto-key) shows in preview and in the exported MP4. */
import { test, expect } from '@playwright/test';
import { startAsGuest, createProject, uploadFixtures, addAsset, saveArtifact, frameRegionColor } from './helpers';

test('animate a logo left → right with keyframes and verify the export', async ({ page }) => {
  test.setTimeout(180_000);
  await startAsGuest(page);
  await createProject(page, 'Keyframes');
  await uploadFixtures(page, ['logo.png']);
  await addAsset(page, 'logo.png'); // 400×200 native, 5 s
  const insp = page.getByTestId('inspector');
  await page.keyboard.press('Home');
  // Key 1 at 0 s: x = -600.
  await insp.getByTestId('add-keyframe').click();
  await insp.getByLabel('X', { exact: true }).fill('-600');
  await insp.getByLabel('X', { exact: true }).press('Enter');
  // Key 2 at 4 s: x = +600 (auto-key creates the keyframe).
  await page.getByTestId('ruler').click({ position: { x: 4 * 60, y: 10 } });
  await insp.getByLabel('X', { exact: true }).fill('600');
  await insp.getByLabel('X', { exact: true }).press('Enter');
  await expect(insp.locator('.kf-list li')).toHaveCount(2);
  await expect(page.locator('.kf-diamond')).toHaveCount(2);
  // At 2 s the inspector shows the interpolated value (0).
  await page.getByTestId('ruler').click({ position: { x: 2 * 60, y: 10 } });
  await expect.poll(async () => Math.abs(parseFloat(await insp.getByLabel('X', { exact: true }).inputValue()))).toBeLessThan(20);

  await page.getByTestId('open-export').click();
  await page.getByTestId('export-preset').selectOption('720p');
  await page.getByTestId('start-export').click();
  await expect(page.locator('[data-testid="export-item"][data-status="completed"]').first()).toBeVisible({ timeout: 120_000 });
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-export').first().click()]);
  const file = saveArtifact('keyframes-export.mp4', Buffer.alloc(0));
  await d.saveAs(file);
  // 720p scale = 2/3. At 0 s logo center x = 640 + (-600·2/3) = 240; at 4 s → 1040.
  const blue = (c: { r: number; g: number; b: number }) => c.b > 180 && c.r < 120;
  expect(blue(frameRegionColor(file, 0.05, { x: 220, y: 350, w: 40, h: 20 }))).toBe(true);
  expect(blue(frameRegionColor(file, 0.05, { x: 1020, y: 350, w: 40, h: 20 }))).toBe(false);
  expect(blue(frameRegionColor(file, 4.2, { x: 1020, y: 350, w: 40, h: 20 }))).toBe(true);
  expect(blue(frameRegionColor(file, 2, { x: 620, y: 350, w: 40, h: 20 }))).toBe(true);
});
