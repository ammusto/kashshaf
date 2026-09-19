import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The search sidebar makes way for a search.
 *
 * When a search runs the sidebar folds away, so the results and the reader
 * take the width. The user can open it again from the same toggle or with
 * Ctrl/Cmd+B, and having done so, keeps it: the choice is remembered for the
 * session, so someone who reopened it is not fought at every search. A
 * manual collapse leaves the policy alone.
 */
export interface SidebarForSearch {
  open: boolean;
  /** The toggle button and the shortcut. Opening by hand pins it open for the session. */
  toggle: () => void;
  /** A search is starting: collapse, unless the user has pinned it open. */
  collapseForSearch: () => void;
}

/** The key the shortcut listens for: Ctrl+B, or Cmd+B on a Mac. */
export function isSidebarShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'b';
}

export function useSidebarForSearch(initiallyOpen = true): SidebarForSearch {
  const [open, setOpen] = useState(initiallyOpen);
  /** The user opened it after a search folded it: leave it alone from now on. */
  const pinnedOpen = useRef(false);

  const toggle = useCallback(() => {
    setOpen((was) => {
      if (!was) pinnedOpen.current = true;
      return !was;
    });
  }, []);

  const collapseForSearch = useCallback(() => {
    if (pinnedOpen.current) return;
    setOpen(false);
  }, []);

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
