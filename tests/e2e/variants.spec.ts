/** AI-10: create a 9:16 social variant from a 16:9 project; original stays unchanged. */
import { test, expect } from '@playwright/test';
import { startAsGuest, createProject, uploadFixtures, addAsset, waitSaved, canvasColor } from './helpers';

test('create a vertical variant with filled framing', async ({ page }) => {
  await startAsGuest(page);
  await createProject(page, 'Wide');
  await uploadFixtures(page, ['clip-b-silent-1080p.mp4']);
  await addAsset(page, 'clip-b-silent-1080p.mp4');
  await waitSaved(page);
  const originalUrl = page.url();
  await page.getByTestId('open-export').click();
  await page.getByTestId('variant-9:16').click();
  await expect(page.getByTestId('project-title')).toHaveText('Wide (9:16)');
  await expect(page.getByText('1080×1920 · 30 fps')).toBeVisible();
  expect(page.url()).not.toBe(originalUrl);
  // Filled framing: the top band of the vertical frame is covered by video (not black letterbox).
  await page.getByTestId('ruler').click({ position: { x: 120, y: 10 } });
  await expect.poll(async () => { const c = await canvasColor(page, 0.3, 0.05, 0.4, 0.1); return c.r + c.g + c.b; }, { timeout: 20_000 }).toBeGreaterThan(60);
  await page.goto(originalUrl);
  await expect(page.getByText('1920×1080 · 30 fps')).toBeVisible();
});
