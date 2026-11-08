/** Mouse interactions on the timeline: drag-move with snapping, edge trims, library → track drop, cross-track drag. */
import { test, expect, type Page } from '@playwright/test';
import { startAsGuest, createProject, uploadFixtures, addAsset } from './helpers';

test.use({ viewport: { width: 1600, height: 1000 } });

async function clipBox(page: Page, sel: string) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error('no clip ' + sel);
  return b;
}
const label = (page: Page, sel: string) => page.locator(sel).first().getAttribute('aria-label');
/** Parse "…, m:ss.s to m:ss.s" into seconds. */
async function range(page: Page, sel: string): Promise<[number, number]> {
  const l = (await label(page, sel)) ?? '';
  const m = l.match(/(\d+):(\d+\.\d) to (\d+):(\d+\.\d)/);
  if (!m) return [NaN, NaN];
  return [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])];
}
async function expectRange(page: Page, sel: string, start: number, end: number, tol = 0.25) {
  await expect
    .poll(async () => {
      const [a, b] = await range(page, sel);
      return Math.abs(a - start) <= tol && Math.abs(b - end) <= tol ? 'ok' : `${a}-${b}`;
    })
    .toBe('ok');
}

test('drag move, snap, trim edges, drop from library, move across tracks', async ({ page }) => {
  await startAsGuest(page);
  await createProject(page, 'Drag');
  await uploadFixtures(page, ['clip-c-portrait.mp4', 'logo.png']);
  await addAsset(page, 'clip-c-portrait.mp4'); // V1 [0, 25)
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(200);
  const zoom = (await clipBox(page, '[data-clip-kind="video"]')).width / 25; // px per second

  // Trim the right edge from 25s to ~10s.
  let b = await clipBox(page, '[data-clip-kind="video"]');
  await page.mouse.move(b.x + b.width - 3, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 10 * zoom, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expectRange(page, '[data-clip-kind="video"]', 0, 10);

  // Trim the left edge to ~2s (source offset shifts).
  b = await clipBox(page, '[data-clip-kind="video"]');
  await page.mouse.move(b.x + 3, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 2 * zoom, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expectRange(page, '[data-clip-kind="video"]', 2, 10);
  const [s2] = await range(page, '[data-clip-kind="video"]');
  // Source offset moved with the start edge (speed 1): source in == new start.
  await expect.poll(async () => Math.abs(parseFloat(await page.getByTestId('inspector').getByLabel('Source in', { exact: true }).inputValue()) - s2)).toBeLessThan(0.06);

  const [ps, pe] = await range(page, '[data-clip-kind="video"]');
  // Drag-move left by ~1.9s: snaps to timeline start (0).
  b = await clipBox(page, '[data-clip-kind="video"]');
  await page.mouse.move(b.x + 40, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 40 - 1.9 * zoom, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
  // Snapped exactly to 0 and kept its duration.
  await expectRange(page, '[data-clip-kind="video"]', 0, pe - ps, 0.11);

  // Drag the logo from the library onto V2 at ~3s.
  const lane = page.getByTestId('lane-V2');
  const lb = (await lane.boundingBox())!;
  await page.locator('[data-testid="asset"][data-asset-name="logo.png"]').dragTo(lane, { targetPosition: { x: 3 * zoom, y: lb.height / 2 } });
  await expect(page.locator('[data-clip-kind="image"]')).toHaveCount(1);
  const [is] = await range(page, '[data-clip-kind="image"]');
  expect(Math.abs(is - 3)).toBeLessThan(0.4);
  // The image landed on V2 (upper track).
  await expect(page.getByTestId('lane-V2').locator('[data-clip-kind="image"]')).toHaveCount(1);

  // Drag the image down one track (V2 → V1) and right; overlaps are allowed on the same track.
  b = await clipBox(page, '[data-clip-kind="image"]');
  const v1 = (await page.getByTestId('lane-V1').boundingBox())!;
  await page.mouse.move(b.x + 20, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 20 + 0.5 * zoom, v1.y + v1.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId('lane-V1').locator('[data-clip-kind="image"]')).toHaveCount(1);

  // Undo restores it to V2.
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('lane-V2').locator('[data-clip-kind="image"]')).toHaveCount(1);

  // Keyboard nudge: Alt+Shift+→ moves the selected video clip by one second.
  await page.locator('[data-clip-kind="video"]').first().click({ position: { x: 30, y: 20 } });
  const [n0, n1] = await range(page, '[data-clip-kind="video"]');
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expectRange(page, '[data-clip-kind="video"]', n0 + 1, n1 + 1, 0.05);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(async () => (await range(page, '[data-clip-kind="video"]'))[0]).toBeCloseTo(n0 + 1 - 1 / 30, 1);
});
