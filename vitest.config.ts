import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Frontend unit tests: `npm test` (vitest run). Components under test mock
// the Tauri bridge (`src/api/tauri`, `@tauri-apps/api/*`), so no desktop
// runtime is needed.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
  },
});
