/**
 * Journey B (registered user returns later) + cross-user access denial in the browser.
 */
import { test, expect } from '@playwright/test';
import { register, createProject, uploadFixtures, addAsset, waitSaved } from './helpers';

test.setTimeout(180_000);

test('registered user saves, signs out, signs in and reopens; another user is denied', async ({ page, browser }) => {
  const email = `e2e-${Date.now()}@example.com`;
  const password = 'correct horse battery';
  await register(page, email, password);
  await createProject(page, 'Return Later');
  await uploadFixtures(page, ['logo.png', 'music.mp3']);
  await addAsset(page, 'logo.png');
  await addAsset(page, 'music.mp3');
  // Set precise volume on the music clip.
  await page.locator('[data-clip-kind="audio"]').click();
  await page.getByTestId('text-tab').click();
  await page.getByTestId('add-title').click();
  await waitSaved(page);
  const url = page.url();

  // Sign out → sign in → reopen.
  await page.getByTestId('account-menu').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open Return Later' }).click();
  await expect(page.getByTestId('clip')).toHaveCount(3);
  await expect(page.locator('[data-clip-kind="image"]')).toHaveCount(1);
  await expect(page.locator('[data-clip-kind="text"]')).toHaveCount(1);

  // Make another change, then it saves again.
  await page.locator('[data-clip-kind="image"]').click();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('clip')).toHaveCount(2);
  await waitSaved(page);

  // A different user cannot open this project URL.
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto('/');
  await p2.getByRole('button', { name: 'Continue as guest' }).click();
  await p2.goto(url);
  await expect(p2.getByRole('alert')).toContainText(/not found|access/i);
  const projectId = url.split('/project/')[1];
  const res = await p2.request.get(`/api/projects/${projectId}`);
  expect(res.status()).toBe(404);
  await ctx2.close();
});
