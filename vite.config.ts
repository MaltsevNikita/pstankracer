import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 4001,
    strictPort: true,
  },
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
  },
});
