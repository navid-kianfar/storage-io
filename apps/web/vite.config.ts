import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const API_TARGET = process.env.VITE_DEV_API_TARGET ?? 'http://localhost:3000';
const WEB_PORT = 5173;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      // Server-Sent Events: no buffering, no timeout, no compression.
      '/api/v1/events': {
        target: API_TARGET,
        changeOrigin: true,
        ws: false,
        // A stream must never be buffered by the proxy or the UI stalls.
        selfHandleResponse: false,
        timeout: 0,
        proxyTimeout: 0,
        headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' },
      },
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
  preview: { port: 4174, strictPort: true },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // No manual chunking: Vite 8 bundles with rolldown, and the heavy libraries are
    // split where they are used instead — CodeMirror behind the lazy boundary in
    // src/components/app/CodeEditor.tsx, and Recharts (via @/components/ui/chart)
    // behind whatever lazy boundary the page that charts puts it behind.
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
