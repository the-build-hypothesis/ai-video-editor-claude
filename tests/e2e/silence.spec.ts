/** AI-09: silence detection proposes cuts, applies as one undoable edit (WAV import also covered). */
import { test, expect } from '@playwright/test';
import { startAsGuest, createProject, uploadFixtures, addAsset } from './helpers';

test('find and remove silent parts of an audio clip, then undo', async ({ page }) => {
  await startAsGuest(page);
  await createProject(page, 'Silence');
  await uploadFixtures(page, ['tones-with-gap.wav']);
  await addAsset(page, 'tones-with-gap.wav');
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveAttribute('aria-label', /0:00.0 to 0:03.5/);
  await page.getByTestId('find-silences').click();
  await expect(page.getByTestId('apply-silences')).toBeVisible();
  await expect(page.getByTestId('silence-tool').locator('.op')).toHaveCount(1);
  await page.getByTestId('apply-silences').click();
  // 1.5s gap minus 2×0.15s padding ≈ 1.2s removed → two pieces totalling ≈ 2.3s
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(2);
  const labels = await page.locator('[data-clip-kind="audio"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(labels[1]).toMatch(/to 0:02\.[23]/);
  await page.getByTestId('undo').click();
  await expect(page.locator('[data-clip-kind="audio"]')).toHaveCount(1);
});
