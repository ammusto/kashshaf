/**
 * Stub for @tauri-apps/plugin-shell
 * Used in web builds where Tauri is not available
 */

export function open(url: string): Promise<void> {
  // In web, we can use window.open
  window.open(url, '_blank');
  return Promise.resolve();
}
