import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Port 5174, one above Kashshaf's 5173, so both dev servers can run at once —
// which is the normal case while working on shared code.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5174, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  resolve: {
    alias: {
      // Shared with Kashshaf (Lab spec §2.2). Source, resolved here; there is
      // no build artefact and nothing to publish between the two apps.
      '@kashshaf/shared': fileURLToPath(new URL('../packages/kashshaf-shared/src/index.ts', import.meta.url)),
    },
    // The shared source sits outside lab/, so its bare imports would resolve
    // from the repository root's node_modules. React is deduped by the plugin;
    // the virtualiser the contents tree uses must be too, so one copy serves.
    dedupe: ['@tanstack/react-virtual'],
  },
})
