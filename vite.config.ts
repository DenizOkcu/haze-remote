import { defineConfig } from 'vite';
export default defineConfig({
  root: 'client',
  base: '/remote/',
  build: { outDir: '../dist/client', emptyOutDir: true, target: 'es2022' },
});
