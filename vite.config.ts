import { defineConfig } from 'vite';
export default defineConfig({
  root: 'client',
  build: { outDir: '../dist/client', emptyOutDir: true, target: 'es2022' },
});
