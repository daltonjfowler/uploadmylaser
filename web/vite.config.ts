import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Multi-page: student app, teacher page, class display. The Phase 0 serial test page
// (serial-test.html) is left OUT of the build on purpose: it streams any .rd file straight to the
// laser, past every server clamp and the Frame step. It still works in `npm run dev:web`.
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
      },
    },
  },
  server: {
    // `npm run dev:web` against a running `wrangler dev` on :8787
    proxy: { '/api': 'http://localhost:8787' },
  },
});
