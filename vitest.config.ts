// Unit tests run in plain Node without the Cloudflare/React Vite plugins (the Cloudflare plugin
// cannot start inside vitest). Vitest prefers this file over vite.config.ts.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
