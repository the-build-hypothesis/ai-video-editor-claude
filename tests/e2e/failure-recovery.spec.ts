/**
 * Journey E — failure recovery. Server failures are injected with request interception; the UI must
 * show actionable errors with a retry path and the saved project must stay intact.
 */
import { test, expect } from '@playwright/test';
import { startAsGuest, createProject, uploadFixtures, addAsset, waitSaved, FIXTURES } from './helpers';
import path from 'node:path';

test.setTimeout(240_000);

test('failed upload, transcription, AI plan and export recover without corrupting the project', async ({ page }) => {
  await startAsGuest(page);
  await createProject(page, 'Recovery');

  // 1) Upload fails once (server 500) → error + Retry → succeeds.
  let failUpload = true;
  await page.route('**/api/assets/*/content', async (route) => {
    if (route.request().method() === 'PUT' && failUpload) {
      failUpload = false;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'Injected storage failure', requestId: 'test' } }) });
    }
    return route.continue();
  });
  await page.getByTestId('file-input').setInputFiles(path.join(FIXTURES, 'clip-a-speech-720p.mp4'));
  await expect(page.locator('.upload-error-msg')).toContainText('Injected storage failure', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Retry' }).first().click();
  await expect(page.locator('[data-testid="asset"][data-asset-name="clip-a-speech-720p.mp4"]')).toBeVisible({ timeout: 30_000 });
  await page.unroute('**/api/assets/*/content');
  await addAsset(page, 'clip-a-speech-720p.mp4');
  await uploadFixtures(page, ['logo.png']);
  await waitSaved(page);

  // 2) Transcription fails (provider error) → actionable message with Retry; captions unchanged.
  await page.route('**/api/ai/transcribe', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ai_provider_error', message: 'AI provider is temporarily unavailable. Please retry.', requestId: 'test' } }) }));
  await page.getByTestId('tab-captions').click();
  await page.getByTestId('transcribe').click();
  await expect(page.getByRole('alert').filter({ hasText: 'temporarily unavailable' })).toBeVisible();
  await expect(page.getByRole('alert').getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(await page.getByTestId('caption-item').count()).toBe(0);
  await page.unroute('**/api/ai/transcribe');

  // 3) AI plan fails → error with retry; nothing applied.
  await page.route('**/api/ai/plan', (route) => route.fulfill({ status: 504, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ai_provider_error', message: 'AI provider timed out', requestId: 'test' } }) }));
  await page.getByTestId('tab-ai').click();
  await page.getByTestId('ai-instruction').fill('Add a title');
  await page.getByTestId('ai-submit').click();
  await expect(page.getByRole('alert').filter({ hasText: 'timed out' })).toBeVisible();
  await expect(page.getByTestId('clip')).toHaveCount(1);
  await page.unroute('**/api/ai/plan');

  // 4) Export upload fails → job marked failed, error + Retry, project untouched; retry succeeds.
  let failExport = true;
  await page.route('**/api/exports/*/file', (route) => {
    if (failExport) {
      failExport = false;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'Injected export storage failure', requestId: 'test' } }) });
    }
    return route.continue();
  });
  await page.getByTestId('open-export').click();
  await page.getByTestId('export-preset').selectOption('720p');
  await page.getByTestId('start-export').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Injected export storage failure' })).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('[data-testid="export-item"][data-status="failed"]')).toHaveCount(1);
  await page.getByRole('alert').getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('[data-testid="export-item"][data-status="completed"]')).toHaveCount(1, { timeout: 120_000 });

  // Project still intact after reload.
  await page.reload();
  await expect(page.getByTestId('clip')).toHaveCount(1);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
});

test('autosave conflict from another tab is detected and resolvable', async ({ page, context }) => {
  await startAsGuest(page);
  await createProject(page, 'Conflict');
  const url = page.url();
  const other = await context.newPage();
  await other.goto(url);
  await other.getByTestId('text-tab').click();
  await other.getByTestId('add-title').click();
  await expect(other.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  // First tab (stale) edits → conflict.
  await page.getByTestId('text-tab').click();
  await page.getByTestId('add-lowerThird').click();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'conflict', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Load latest' }).click();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  await expect(page.locator('[data-clip-kind="text"]')).toHaveCount(1);
});
