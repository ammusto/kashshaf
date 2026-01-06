/**
 * Stub for @tauri-apps/api/event
 * Used in web builds where Tauri is not available
 */

export type UnlistenFn = () => void;

export function listen(_event: string, _handler: (event: unknown) => void): Promise<UnlistenFn> {
  // Return a no-op unlisten function
  return Promise.resolve(() => {});
}

export function emit(_event: string, _payload?: unknown): Promise<void> {
  return Promise.resolve();
}
