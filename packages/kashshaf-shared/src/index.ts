/**
 * `@kashshaf/shared` — code used by both the Kashshaf and the Kashshaf Lab
 * frontends (Lab lives in the sibling `kashshaf-lab` repository and resolves this
 * package by path; its spec is kashshaf-lab/dev-docs/KASHSHAF_LAB_SPEC.md §2.2).
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
export { readBody, headingAt } from './utils/bodyText';
export type { BodyText, HeadingRange } from './utils/bodyText';
export { TokenPopup } from './components/TokenPopup';
export type { TokenPopupProps } from './components/TokenPopup';
export { TocTree, ancestorsOf, prune, flattenToc, entryForPage } from './components/TocTree';
export type { TocEntry, TocRowLike, TocTreeProps } from './components/TocTree';
export { CROSS_PAGE_MAX_SPAN, LONG_PHRASE_NOTE, phraseExceedsCrossPageSpan, pageLabelC1, continuationLabel, secondaryIsAfter } from './utils/crossPage';
export type { SecondarySpan } from './utils/crossPage';
export { ErrorBoundary } from './components/ErrorBoundary';
export type { ErrorBoundaryProps } from './components/ErrorBoundary';
