import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import svgr from 'vite-plugin-svgr'

const isWebTarget = process.env.VITE_TARGET === 'web'

export default defineConfig({
  plugins: [react(), svgr()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    // Web build outputs to dist/
    outDir: isWebTarget ? 'dist' : 'dist',
  },
  define: {
    // Make VITE_TARGET available in code
    'import.meta.env.VITE_TARGET': JSON.stringify(process.env.VITE_TARGET || 'desktop'),
  },
  resolve: {
    alias: isWebTarget ? {
      // Stub out Tauri imports for web build
      '@tauri-apps/api/core': '/src/stubs/tauri-core.ts',
      '@tauri-apps/api/event': '/src/stubs/tauri-event.ts',
      '@tauri-apps/plugin-shell': '/src/stubs/tauri-shell.ts',
      '@tauri-apps/plugin-dialog': '/src/stubs/tauri-dialog.ts',
      '@tauri-apps/plugin-fs': '/src/stubs/tauri-fs.ts',
    } : {},
  },
})
