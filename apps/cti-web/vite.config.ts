import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src',
  // Built bundle is served by the API at /cti/* — keep asset paths relative
  // so index.html can resolve them regardless of the prefix.
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: true,
    // One bundle on purpose (~545 kB): the Twilio SDK ships inside it, never
    // as a lazy chunk a deploy could delete out from under an open tab
    // (2026-10-20, "Inbound calls unavailable"). Don't split it to quiet this.
    chunkSizeWarningLimit: 650,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
