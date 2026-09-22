import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/trader_bot/' : '/',
  publicDir: false,
  build: {
    target: 'es2022',
  },
}));
