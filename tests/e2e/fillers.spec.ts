/** AI-09: filler-word detection (real Whisper with a disfluency prompt) → review → cut → undo. */
import { test, expect } from '@playwright/test';
import { startAsGuest, createProject, uploadFixtures, addAsset } from './helpers';

test.skip(!!process.env.SKIP_REAL_AI, 'real OpenAI calls disabled');

test('detect and cut filler words', async ({ page }) => {
  test.setTimeout(180_000);
  await startAsGuest(page);
  await createProject(page, 'Fillers');
  await uploadFixtures(page, ['clip-f-fillers.mp4']);
  await addAsset(page, 'clip-f-fillers.mp4');
  await page.getByTestId('tab-captions').click();
  await page.getByTestId('detect-fillers').check();
  await page.getByTestId('transcribe').click();
  await expect(page.getByTestId('caption-item').first()).toBeVisible({ timeout: 90_000 });
  const caps = (await page.getByTestId('caption-text').evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value).join(' '))).toLowerCase();
  console.log('[fillers] captions:', caps);
  await expect(page.getByTestId('filler-section')).toBeVisible();
  console.log('[fillers] detected:', await page.locator('.filler-chip').allTextContents());
  // Captions exclude the fillers themselves.
  expect(caps).not.toMatch(/\bum\b|\buh\b/);
  const before = await page.locator('[data-clip-kind="video"]').count();
  await page.getByTestId('remove-fillers').click();
  await expect.poll(() => page.locator('[data-clip-kind="video"]').count()).toBeGreaterThan(before);
  await expect(page.getByTestId('filler-section')).toHaveCount(0);
  await page.getByTestId('undo').click();
  await expect(page.locator('[data-clip-kind="video"]')).toHaveCount(before);
});
