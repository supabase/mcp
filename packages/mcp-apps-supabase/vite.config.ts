import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds ui/api-gateway-report.html into one self-contained file
// (dist-ui/api-gateway-report.html) that tsup then embeds as a string.
export default defineConfig({
  root: 'ui',
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: '../dist-ui',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: 'ui/api-gateway-report.html' },
  },
});
