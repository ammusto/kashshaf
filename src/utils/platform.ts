/**
 * Platform Detection Utilities
 *
 * Provides functions to check the build target (web vs desktop)
 */

/**
 * Returns true if running as a web build (no Tauri)
 */
export function isWebTarget(): boolean {
  return import.meta.env.VITE_TARGET === 'web';
}

/**
 * Returns true if running as a desktop Tauri build
 */
export function isDesktopTarget(): boolean {
  return import.meta.env.VITE_TARGET !== 'web';
}

/**
 * Get the API base URL
 * - Web: Uses VITE_API_URL or defaults to https://api.kashshaf.com
 * - Desktop: Not used (API is local)
 */
export function getApiBaseUrl(): string {
  return import.meta.env.VITE_API_URL || 'https://api.kashshaf.com';
}
