import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The UI lives in ui/ and builds to dist/, which both servers serve (src/server.mjs, src/web.mjs).
// `npm run dev:ui` proxies /api to a running `droidpanel` (desktop mode) on :4321.
export default defineConfig({
  root: 'ui',
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022', // top-level await in core/api.js
  },
  server: {
    fs: { allow: ['..'] }, // shared/device.js sits outside ui/
    proxy: { '/api': { target: 'http://127.0.0.1:4321', changeOrigin: true, ws: true } },
  },
});
