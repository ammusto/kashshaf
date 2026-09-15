/**
 * `@kashshaf/shared` — code used by both the Kashshaf and the Kashshaf Lab
 * frontends (dev-docs/KASHSHAF_LAB_SPEC.md §2.2).
 *
 * Resolved by a path alias in each app's `vite.config.ts` / `vitest.config.ts`
 * / `tsconfig.json`; there is no build step and no publish. Anything added
 * here must be importable by both apps, which means: no Tauri imports, no
 * app-specific contexts, no router or tab-model assumptions.
 */

export * from './types/corpus';
export * from './utils/arabicTokenizer';
export * from './utils/arabicSearch';
export * from './utils/sanitize';
export * from './utils/citation';
export { TokenPopup } from './components/TokenPopup';
export type { TokenPopupProps } from './components/TokenPopup';
