import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSidebarForSearch, isSidebarShortcut } from './useSidebarForSearch';

describe('the sidebar makes way for a search', () => {
  it('folds when a search runs', () => {
    const { result } = renderHook(() => useSidebarForSearch());
    expect(result.current.open).toBe(true);
    act(() => result.current.collapseForSearch());
    expect(result.current.open).toBe(false);
  });

  it('folds on every search, however often it was reopened', () => {
    const { result } = renderHook(() => useSidebarForSearch());
    act(() => result.current.collapseForSearch());
    act(() => result.current.toggle());
    expect(result.current.open).toBe(true);
    act(() => result.current.collapseForSearch());
    expect(result.current.open).toBe(false);
    act(() => result.current.toggle());
    act(() => result.current.collapseForSearch());
    expect(result.current.open).toBe(false);
  });

  it('Ctrl+B and Cmd+B toggle it', () => {
    const { result } = renderHook(() => useSidebarForSearch());
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
    });
    expect(result.current.open).toBe(false);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'B', metaKey: true }));
    });
    expect(result.current.open).toBe(true);
  });

  it('the shortcut is Ctrl/Cmd+B only', () => {
    expect(isSidebarShortcut({ key: 'b', ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    expect(isSidebarShortcut({ key: 'b', ctrlKey: false, metaKey: true, altKey: false })).toBe(true);
    expect(isSidebarShortcut({ key: 'b', ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(isSidebarShortcut({ key: 'b', ctrlKey: true, metaKey: false, altKey: true })).toBe(false);
    expect(isSidebarShortcut({ key: 'n', ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
  });
});
