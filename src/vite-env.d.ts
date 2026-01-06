/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TARGET: 'web' | 'desktop';
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
