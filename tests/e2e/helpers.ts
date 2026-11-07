import { expect, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export const FIXTURES = path.resolve('fixtures');
export const FFPROBE = path.resolve('node_modules/ffprobe-static/bin/linux/x64/ffprobe');
export const FFMPEG = path.resolve('node_modules/ffmpeg-static/ffmpeg');
export const ARTIFACTS = path.resolve('artifacts');

export function trackConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

export async function startAsGuest(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
}

export async function register(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
}

export async function createProject(page: Page, name: string, aspect = '16:9') {
  await page.getByTestId('new-project').click();
  await page.getByRole('dialog').getByLabel('Name').fill(name);
  await page.getByRole('dialog').locator(`input[value="${aspect}"]`).check({ force: true });
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('project-title')).toHaveText(name);
}

export async function uploadFixtures(page: Page, names: string[]) {
  await page.getByTestId('file-input').setInputFiles(names.map((n) => path.join(FIXTURES, n)));
  for (const n of names) await expect(page.locator(`[data-testid="asset"][data-asset-name="${n}"]`)).toBeVisible({ timeout: 60_000 });
}

export async function addAsset(page: Page, name: string) {
  await page.locator(`[data-testid="asset"][data-asset-name="${name}"]`).getByTestId('add-asset').click();
}

export async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
}

export function ffprobe(file: string) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,profile', '-of', 'json', file]);
  return JSON.parse(out.toString()) as {
    format: { duration: string; format_name: string };
    streams: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number; profile?: string }[];
  };
}

/** Extract one frame at time t (sec) as raw RGB and return the average color of a region. */
export function frameRegionColor(file: string, t: number, region: { x: number; y: number; w: number; h: number }) {
  const buf = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=${region.w}:${region.h}:${region.x}:${region.y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 28 });
  let r = 0,
    g = 0,
    b = 0;
  const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) {
    r += buf[i];
    g += buf[i + 1];
    b += buf[i + 2];
  }
  return { r: r / n, g: g / n, b: b / n };
}

/** Mean audio volume (dB) in a window. */
export function meanVolume(file: string, start: number, dur: number): number {
  const r = spawnSync(FFMPEG, ['-v', 'info', '-ss', String(start), '-t', String(dur), '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-']);
  const m = r.stderr.toString().match(/mean_volume:\s*(-?[\d.]+|-inf) dB/);
  return m ? (m[1] === '-inf' ? -Infinity : parseFloat(m[1])) : NaN;
}

export function saveArtifact(name: string, data: Buffer | string) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const p = path.join(ARTIFACTS, name);
  fs.writeFileSync(p, data);
  return p;
}

/** Average color of a region of the preview canvas (in canvas pixel space fractions). */
export async function canvasColor(page: Page, fx: number, fy: number, fw = 0.05, fh = 0.05) {
  return page.getByTestId('preview-canvas').evaluate(
    (c: HTMLCanvasElement, [fx, fy, fw, fh]) => {
      const ctx = c.getContext('2d')!;
      const x = Math.floor(c.width * fx);
      const y = Math.floor(c.height * fy);
      const w = Math.max(1, Math.floor(c.width * fw));
      const h = Math.max(1, Math.floor(c.height * fh));
      const d = ctx.getImageData(x, y, w, h).data;
      let r = 0,
        g = 0,
        b = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
      }
      const n = d.length / 4;
      return { r: r / n, g: g / n, b: b / n };
    },
    [fx, fy, fw, fh] as const,
  );
}
