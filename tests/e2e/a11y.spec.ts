/**
 * Automated accessibility scan (axe-core, WCAG 2 A/AA rules) of auth, dashboard and editor.
 * Fails on "serious"/"critical" violations; lists moderate ones in the output.
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createProject, uploadFixtures, addAsset } from './helpers';

async function scan(page: Page, name: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).exclude('canvas').analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  for (const v of r.violations) console.log(`[a11y:${name}] ${v.impact} ${v.id} (${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
  return bad;
}

test('no serious/critical axe violations on key screens', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue as guest' })).toBeVisible();
  const auth = await scan(page, 'auth');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  const dash = await scan(page, 'dashboard');
  await createProject(page, 'A11y');
  await uploadFixtures(page, ['clip-a-speech-720p.mp4', 'music.mp3']);
  await addAsset(page, 'clip-a-speech-720p.mp4');
  await addAsset(page, 'music.mp3');
  const editor = await scan(page, 'editor');
  for (const tab of ['captions', 'ai', 'export']) {
    await page.getByTestId(`tab-${tab}`).click();
    editor.push(...(await scan(page, `editor-${tab}`)));
  }
  expect([...auth, ...dash, ...editor].map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
