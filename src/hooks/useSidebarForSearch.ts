import { useCallback, useEffect, useState } from 'react';

/**
 * The search sidebar makes way for a search.
 *
 * Every search folds the sidebar, so the results and the reader take the
 * width; the user opens it again from the same toggle or with Ctrl/Cmd+B.
 * That is the whole rule. An earlier version remembered a reopen and stopped
 * folding for the session, which read as the fold being broken.
 */
export interface SidebarForSearch {
  open: boolean;
  /** The toggle button and the shortcut. */
  toggle: () => void;
  /** A search is starting: fold. */
  collapseForSearch: () => void;
}

/** The key the shortcut listens for: Ctrl+B, or Cmd+B on a Mac. */
export function isSidebarShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'b';
}

export function useSidebarForSearch(initiallyOpen = true): SidebarForSearch {
  const [open, setOpen] = useState(initiallyOpen);

  const toggle = useCallback(() => setOpen((was) => !was), []);

  const collapseForSearch = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSidebarShortcut(e)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  return { open, toggle, collapseForSearch };
}
