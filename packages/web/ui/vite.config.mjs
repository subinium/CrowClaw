import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
  },
  plugins: [viteSingleFile()],
});
