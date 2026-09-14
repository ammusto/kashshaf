import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Frontend unit tests: `npm test` (vitest run). Components under test mock
// the Tauri bridge (`src/api/tauri`, `@tauri-apps/api/*`), so no desktop
// runtime is needed.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@kashshaf/shared': fileURLToPath(new URL('./packages/kashshaf-shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    // The shared package's tests run here too: it has no build of its own,
    // and the tokenizer's alignment contract (Lab spec §3.3) is the reason
    // it exists.
    include: ['src/**/*.test.{ts,tsx}', 'packages/kashshaf-shared/src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
  },
});
