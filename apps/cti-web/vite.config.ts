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
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
