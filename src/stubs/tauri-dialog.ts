/**
 * Stub for @tauri-apps/plugin-dialog
 * Used in web builds where Tauri is not available
 */

export interface SaveDialogOptions {
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  title?: string;
}

export interface OpenDialogOptions {
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  multiple?: boolean;
  directory?: boolean;
  title?: string;
}

export function save(_options?: SaveDialogOptions): Promise<string | null> {
  console.warn('File dialogs are not available in web build');
  return Promise.resolve(null);
}

export function open(_options?: OpenDialogOptions): Promise<string | string[] | null> {
  console.warn('File dialogs are not available in web build');
  return Promise.resolve(null);
}
