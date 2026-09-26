import { useCallback, useEffect, useState } from 'react';

/**
 * The two behaviour preferences Lab shares with Kashshaf, kept in
 * localStorage: a search folds the search rail (default on); opening a
 * book shows the contents pane (default on).
 */
export interface UiSettings {
  autoCollapseSidebar: boolean;
  autoShowToc: boolean;
}

export const UI_SETTING_DEFAULTS: UiSettings = { autoCollapseSidebar: true, autoShowToc: true };
const KEY = 'lab.ui.settings';

export function readUiSettings(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): UiSettings {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return { ...UI_SETTING_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    return {
      autoCollapseSidebar: typeof parsed.autoCollapseSidebar === 'boolean' ? parsed.autoCollapseSidebar : true,
      autoShowToc: typeof parsed.autoShowToc === 'boolean' ? parsed.autoShowToc : true,
    };
  } catch {
    return { ...UI_SETTING_DEFAULTS };
  }
}

export function writeUiSettings(s: UiSettings, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(s));
  } catch {
    /* no storage: the choice lasts the session */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The settings and a persisting setter; every mount reads the store, so a change is seen on the next panel. */
export function useUiSettings(): { settings: UiSettings; set: (name: keyof UiSettings, value: boolean) => void } {
  const [settings, setSettings] = useState<UiSettings>(() => readUiSettings());
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setSettings(readUiSettings());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const set = useCallback((name: keyof UiSettings, value: boolean) => {
    setSettings((was) => {
      const next = { ...was, [name]: value };
      writeUiSettings(next);
      return next;
    });
  }, []);
  return { settings, set };
}
