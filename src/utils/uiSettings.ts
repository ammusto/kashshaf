import { useCallback, useEffect, useState } from 'react';
import { getAppSetting, setAppSetting } from './storage';

/**
 * The two behaviour preferences, persisted in the app settings (settings.db
 * on the desktop, localStorage on the web) and read once at startup.
 *
 * - `autoCollapseSidebar`: a search folds the search sidebar (the rule the
 *   app always had, now a choice). Default on.
 * - `autoShowToc`: opening a book from a result shows the table of contents
 *   the first time in a session. Default on.
 */
export interface UiSettings {
  autoCollapseSidebar: boolean;
  autoShowToc: boolean;
}

export const UI_SETTING_KEYS: Record<keyof UiSettings, string> = {
  autoCollapseSidebar: 'ui.auto_collapse_sidebar',
  autoShowToc: 'ui.auto_show_toc',
};

export const UI_SETTING_DEFAULTS: UiSettings = { autoCollapseSidebar: true, autoShowToc: true };

/** Where the settings live; the app's store by default, a fake in tests. */
export interface SettingsStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

const appStore: SettingsStore = { get: getAppSetting, set: setAppSetting };

export async function readUiSettings(store: SettingsStore = appStore): Promise<UiSettings> {
  const out = { ...UI_SETTING_DEFAULTS };
  for (const name of Object.keys(UI_SETTING_KEYS) as (keyof UiSettings)[]) {
    try {
      const v = await store.get(UI_SETTING_KEYS[name]);
      if (v === 'true' || v === 'false') out[name] = v === 'true';
    } catch {
      /* unreadable: the default stands */
    }
  }
  return out;
}

export async function writeUiSetting(name: keyof UiSettings, value: boolean, store: SettingsStore = appStore): Promise<void> {
  await store.set(UI_SETTING_KEYS[name], value ? 'true' : 'false');
}

/** The settings, read on mount, with a setter that persists. */
export function useUiSettings(store: SettingsStore = appStore): { settings: UiSettings; loaded: boolean; set: (name: keyof UiSettings, value: boolean) => void } {
  const [settings, setSettings] = useState<UiSettings>(UI_SETTING_DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    readUiSettings(store).then((s) => {
      if (live) {
        setSettings(s);
        setLoaded(true);
      }
    });
    return () => {
      live = false;
    };
  }, [store]);
  const set = useCallback(
    (name: keyof UiSettings, value: boolean) => {
      setSettings((was) => ({ ...was, [name]: value }));
      void writeUiSetting(name, value, store);
    },
    [store]
  );
  return { settings, loaded, set };
}
