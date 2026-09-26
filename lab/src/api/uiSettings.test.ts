import { describe, it, expect, beforeEach } from 'vitest';
import { readUiSettings, writeUiSettings, UI_SETTING_DEFAULTS } from './uiSettings';

/** localStorage as a reload sees it: the same store, a fresh read. */
describe('the behaviour settings (Lab)', () => {
  beforeEach(() => localStorage.clear());

  it('default to on', () => {
    expect(readUiSettings()).toEqual(UI_SETTING_DEFAULTS);
  });

  it('persist across a reload', () => {
    writeUiSettings({ autoCollapseSidebar: false, autoShowToc: false });
    expect(readUiSettings()).toEqual({ autoCollapseSidebar: false, autoShowToc: false });
  });

  it('ignore a damaged value', () => {
    localStorage.setItem('lab.ui.settings', '{not json');
    expect(readUiSettings()).toEqual(UI_SETTING_DEFAULTS);
    localStorage.setItem('lab.ui.settings', JSON.stringify({ autoShowToc: 'no' }));
    expect(readUiSettings().autoShowToc).toBe(true);
  });
});
