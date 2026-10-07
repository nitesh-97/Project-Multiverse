import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// In development the page is served by Vite and the API by `npm start -w @multiverse/server`; the proxy lets the page
// use relative URLs either way. In production the server serves the built page itself (see packages/server/src/app.ts).
const api = process.env.MV_API ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/projects': api, '/health': api } },
  build: { outDir: 'dist', sourcemap: true },
  test: { environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'], css: false },
});
