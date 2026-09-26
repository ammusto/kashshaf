import { isWebTarget } from './platform';

/**
 * Open a URL in the person's browser: a new tab on the web, the system
 * browser from the desktop app (through Tauri's shell plugin, as the
 * update button does).
 */
export async function openExternal(url: string): Promise<void> {
  if (isWebTarget()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
