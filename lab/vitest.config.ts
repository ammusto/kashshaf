import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Lab's frontend unit tests: `npm test` in lab/. Components mock the Tauri
// bridge (`src/api/lab`), so no desktop runtime is needed. The shared
// package's own tests run from the Kashshaf side, which owns them.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@kashshaf/shared': fileURLToPath(new URL('../packages/kashshaf-shared/src/index.ts', import.meta.url)),
    },
    dedupe: ['@tanstack/react-virtual'],
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
  },
});
