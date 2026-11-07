import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

// FF_STORAGE=d1 builds/runs without the R2 binding; the Worker then stores media in D1 chunks
// (see src/worker/d1-blob.ts). Used while R2 is not enabled on the Cloudflare account.
const useD1Storage = process.env.FF_STORAGE === 'd1';

export default defineConfig({
  plugins: [
    react(),
    cloudflare({
      config: (cfg) => {
        if (useD1Storage) cfg.r2_buckets = [];
      },
    }),
  ],
  build: { sourcemap: true, chunkSizeWarningLimit: 2000 },
});
