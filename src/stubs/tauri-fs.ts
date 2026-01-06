/**
 * Stub for @tauri-apps/plugin-fs
 * Used in web builds where Tauri is not available
 */

export function readTextFile(_path: string): Promise<string> {
  console.warn('File system access is not available in web build');
  return Promise.reject(new Error('File system access is not available in web build'));
}

export function writeTextFile(_path: string, _contents: string): Promise<void> {
  console.warn('File system access is not available in web build');
  return Promise.reject(new Error('File system access is not available in web build'));
}

export function writeFile(_path: string, _data: Uint8Array): Promise<void> {
  console.warn('File system access is not available in web build');
  return Promise.reject(new Error('File system access is not available in web build'));
}

export function readDir(_path: string): Promise<unknown[]> {
  console.warn('File system access is not available in web build');
  return Promise.reject(new Error('File system access is not available in web build'));
}

export function exists(_path: string): Promise<boolean> {
  return Promise.resolve(false);
}
