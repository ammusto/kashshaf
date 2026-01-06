/**
 * Stub for @tauri-apps/api/core
 * Used in web builds where Tauri is not available
 */

export function invoke(_cmd: string, _args?: Record<string, unknown>): Promise<never> {
  throw new Error('Tauri invoke is not available in web build');
}
