import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.API_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL },
  projects: [
    // HTTP-only API tests (no browser).
    { name: 'api', testDir: 'tests/api', fullyParallel: false },
    // Browser E2E. Chromium may need LD_LIBRARY_PATH=$HOME/.local/pwlibs/root/usr/lib/x86_64-linux-gnu locally.
    { name: 'e2e', testDir: 'tests/e2e', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npx vite dev --port 5173 --strictPort',
    url: 'http://localhost:5173/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
