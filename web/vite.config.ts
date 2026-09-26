import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Multi-page: student app, teacher page, and the Phase 0 serial test page.
export default defineConfig({
  root: __dirname,
  build: {
    outDir: resolve(__dirname, '../public'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        teacher: resolve(__dirname, 'teacher/index.html'),
        display: resolve(__dirname, 'display/index.html'),
        serialTest: resolve(__dirname, 'serial-test.html'),
      },
    },
  },
  server: {
    // `npm run dev:web` against a running `wrangler dev` on :8787
    proxy: { '/api': 'http://localhost:8787' },
  },
});
