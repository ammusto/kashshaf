import { useCallback, useEffect, useState } from 'react';
import { SIDEBAR_MIN_WIDTH } from '../constants/search';

/**
 * Whether the contents pane is open, and how wide.
 *
 * Open or closed is a session-wide choice: the pane opens the first time a
 * book is loaded in the reader from a result click, and after that it stays
 * in whatever state the user leaves it, across books and tabs, until the
 * app is closed. Width is kept across sessions, like the search sidebar's.
 */

/** Session memory, deliberately module-level: it must outlive the reader. */
let openMemory: boolean | null = null;

/** Tests need a fresh session. */
export function resetTocPaneMemory() {
  openMemory = null;
}

/** As wide as the search sidebar may be, at the least. */
export const TOC_MIN_WIDTH = SIDEBAR_MIN_WIDTH;
export const TOC_MAX_WIDTH = 720;
export const TOC_DEFAULT_WIDTH = SIDEBAR_MIN_WIDTH;
/** What the reader needs before the contents pane yields its width. */
export const READER_MIN_WIDTH = 520;
const WIDTH_KEY = 'tocWidth';

export function clampTocWidth(w: number): number {
  return Math.min(TOC_MAX_WIDTH, Math.max(TOC_MIN_WIDTH, Math.round(w)));
}

function readWidth(): number {
  try {
    const saved = localStorage.getItem(WIDTH_KEY);
    return saved ? clampTocWidth(parseInt(saved, 10)) : TOC_DEFAULT_WIDTH;
  } catch {
    return TOC_DEFAULT_WIDTH;
  }
}

export interface TocPane {
  /** The user's choice. */
  open: boolean;
  toggle: () => void;
  close: () => void;
  /** A book was just loaded from a result click: the first time, open. */
  openedFromResult: () => void;
  width: number;
  setWidth: (w: number) => void;
}

/** The key the shortcut listens for: Ctrl+T, or Cmd+T on a Mac. */
export function isTocShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 't';
}

export function useTocPane(): TocPane {
  const [open, setOpen] = useState<boolean>(openMemory ?? false);
  const [width, setWidthState] = useState<number>(readWidth);

  const setOpenRemembered = useCallback((v: boolean | ((was: boolean) => boolean)) => {
    setOpen((was) => {
      const next = typeof v === 'function' ? v(was) : v;
      openMemory = next;
      return next;
    });
  }, []);

  const toggle = useCallback(() => setOpenRemembered((was) => !was), [setOpenRemembered]);
  const close = useCallback(() => setOpenRemembered(false), [setOpenRemembered]);
  const openedFromResult = useCallback(() => {
    // Only the session's first: after that the user's own state stands.
    if (openMemory === null) setOpenRemembered(true);
  }, [setOpenRemembered]);

  const setWidth = useCallback((w: number) => {
    const clamped = clampTocWidth(w);
    setWidthState(clamped);
    try {
      localStorage.setItem(WIDTH_KEY, String(clamped));
    } catch {
      /* no storage: the width lasts the session */
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTocShortcut(e)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  return { open, toggle, close, openedFromResult, width, setWidth };
}
