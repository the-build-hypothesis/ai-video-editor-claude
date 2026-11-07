import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [react(), cloudflare()],
  build: { sourcemap: true, chunkSizeWarningLimit: 2000 },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
} as never);
