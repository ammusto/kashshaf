import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { readUiSettings, useUiSettings, UI_SETTING_DEFAULTS, type SettingsStore } from './uiSettings';

/** A store that outlives a "reload": the same map, a fresh hook. */
function fakeStore(): SettingsStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
  };
}

describe('the behaviour settings', () => {
  it('default to on when nothing is stored', async () => {
    expect(await readUiSettings(fakeStore())).toEqual(UI_SETTING_DEFAULTS);
    expect(UI_SETTING_DEFAULTS).toEqual({ autoCollapseSidebar: true, autoShowToc: true });
  });

  it('persist across a reload', async () => {
    const store = fakeStore();
    const first = renderHook(() => useUiSettings(store));
    await waitFor(() => expect(first.result.current.loaded).toBe(true));
    act(() => first.result.current.set('autoCollapseSidebar', false));
    act(() => first.result.current.set('autoShowToc', false));
    expect(first.result.current.settings).toEqual({ autoCollapseSidebar: false, autoShowToc: false });
    first.unmount();
    // The reload: a new hook over the same store.
    const second = renderHook(() => useUiSettings(store));
    await waitFor(() => expect(second.result.current.loaded).toBe(true));
    expect(second.result.current.settings).toEqual({ autoCollapseSidebar: false, autoShowToc: false });
  });

  it('ignores a value that is not a boolean', async () => {
    const store = fakeStore();
    store.data.set('ui.auto_show_toc', 'maybe');
    expect((await readUiSettings(store)).autoShowToc).toBe(true);
  });
});
