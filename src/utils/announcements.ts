/**
 * Announcements Utility
 *
 * Handles fetching, caching, and filtering announcements from CDN.
 * Desktop apps use Tauri/reqwest (no CORS), web uses browser fetch.
 */

import type { Announcement, AnnouncementsManifest } from '../types';
import {
  isWebTarget,
  getAnnouncementsCache,
  setAnnouncementsCache,
  getDismissedAnnouncements,
  getSkipAnnouncementPopups,
} from './storage';

const ANNOUNCEMENTS_URL = 'https://cdn.kashshaf.com/announcements.json';
const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour
const SUPPORTED_SCHEMA_VERSION = 1;
const FETCH_TIMEOUT_MS = 5000; // 5 seconds

/**
 * Fetch announcements via browser fetch (for web target)
 * Returns null on failure (network error, timeout, invalid response)
 */
async function fetchAnnouncementsWeb(): Promise<AnnouncementsManifest | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(ANNOUNCEMENTS_URL, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`Failed to fetch announcements: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();

    // Validate schema version
    if (typeof data.schema_version !== 'number' || data.schema_version !== SUPPORTED_SCHEMA_VERSION) {
      console.warn(`Unsupported announcements schema version: ${data.schema_version}`);
      return null;
    }

    if (!Array.isArray(data.announcements)) {
      console.warn('Invalid announcements format: missing announcements array');
      return null;
    }

    return data as AnnouncementsManifest;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn('Announcements fetch timed out');
    } else {
      console.warn('Failed to fetch announcements:', err);
    }
    return null;
  }
}

/**
 * Fetch announcements via Tauri/reqwest (for desktop targets)
 * Returns null on failure
 */
async function fetchAnnouncementsDesktop(): Promise<AnnouncementsManifest | null> {
  try {
    const { fetchAnnouncements } = await import('../api/tauri');
    const manifest = await fetchAnnouncements();

    // Transform Tauri response: rename announcement_type -> type
    const transformedAnnouncements: Announcement[] = manifest.announcements.map(ann => ({
      id: ann.id,
      title: ann.title,
      body: ann.body,
      body_format: ann.body_format as Announcement['body_format'],
      type: ann.announcement_type as Announcement['type'],
      priority: ann.priority as Announcement['priority'],
      target: ann.target as Announcement['target'],
      min_app_version: ann.min_app_version,
      max_app_version: ann.max_app_version,
      starts_at: ann.starts_at,
      expires_at: ann.expires_at,
      dismissible: ann.dismissible,
      show_once: ann.show_once,
      action: ann.action,
    }));

    return {
      schema_version: manifest.schema_version,
      announcements: transformedAnnouncements,
    };
  } catch (err) {
    console.warn('Failed to fetch announcements via Tauri:', err);
    return null;
  }
}

/**
 * Fetch announcements from CDN
 * Uses Tauri/reqwest for desktop (no CORS), browser fetch for web
 * Returns null on failure (network error, timeout, invalid response)
 */
export async function fetchAnnouncementsFromCDN(): Promise<AnnouncementsManifest | null> {
  if (isWebTarget) {
    return fetchAnnouncementsWeb();
  } else {
    return fetchAnnouncementsDesktop();
  }
}

/**
 * Get announcements with caching
 * Checks cache age, fetches if stale, falls back to cache on failure
 */
export async function getAnnouncementsWithCache(): Promise<Announcement[]> {
  try {
    const cache = await getAnnouncementsCache();
    const now = Date.now();

    // Check if cache is valid and not stale
    if (cache) {
      const fetchedAt = new Date(cache.fetched_at).getTime();
      const cacheAge = now - fetchedAt;

      if (cacheAge < CACHE_DURATION_MS) {
        // Cache is fresh, use it
        return cache.data.announcements;
      }
    }

    // Cache is stale or missing, fetch fresh data
    const manifest = await fetchAnnouncementsFromCDN();

    if (manifest) {
      // Store in cache
      await setAnnouncementsCache({
        data: manifest,
        fetched_at: new Date().toISOString(),
      });
      return manifest.announcements;
    }

    // Fetch failed, try to use stale cache
    if (cache) {
      console.info('Using stale announcements cache due to fetch failure');
      return cache.data.announcements;
    }

    // No cache available
    return [];
  } catch (err) {
    console.error('Error getting announcements:', err);
    return [];
  }
}

/**
 * Compare semver versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareSemver(a: string, b: string): number {
  const partsA = a.split('.').map(n => parseInt(n, 10) || 0);
  const partsB = b.split('.').map(n => parseInt(n, 10) || 0);

  // Ensure both have at least 3 parts
  while (partsA.length < 3) partsA.push(0);
  while (partsB.length < 3) partsB.push(0);

  for (let i = 0; i < 3; i++) {
    if (partsA[i] < partsB[i]) return -1;
    if (partsA[i] > partsB[i]) return 1;
  }

  return 0;
}

/**
 * Check if app version is within the specified range
 */
export function isWithinVersionRange(
  appVersion: string,
  min: string | null,
  max: string | null
): boolean {
  if (min !== null && compareSemver(appVersion, min) < 0) {
    return false;
  }
  if (max !== null && compareSemver(appVersion, max) > 0) {
    return false;
  }
  return true;
}

/**
 * Get priority order for sorting (lower = higher priority = shows first)
 */
function getPriorityOrder(priority: Announcement['priority']): number {
  switch (priority) {
    case 'forced':
      return 0;
    case 'important':
      return 1;
    case 'normal':
      return 2;
    default:
      return 3;
  }
}

/**
 * Check if an announcement has been dismissed
 */
async function isAnnouncementDismissed(id: string): Promise<boolean> {
  const dismissed = await getDismissedAnnouncements();
  return dismissed.some(d => d.id === id);
}

/**
 * Get eligible announcements based on platform, date, version, and dismissal status
 */
export async function getEligibleAnnouncements(appVersion: string): Promise<Announcement[]> {
  const announcements = await getAnnouncementsWithCache();
  const now = new Date();
  const isWeb = isWebTarget;

  // Get user preference for skipping normal announcements
  const skipNormalAnnouncements = await getSkipAnnouncementPopups();

  const eligibleAnnouncements: Announcement[] = [];

  for (const announcement of announcements) {
    // Check platform targeting
    if (announcement.target !== 'all') {
      if (isWeb && announcement.target !== 'web') continue;
      if (!isWeb && announcement.target !== 'desktop') continue;
    }

    // Check date range
    const startsAt = new Date(announcement.starts_at);
    if (now < startsAt) continue; // Not started yet

    if (announcement.expires_at) {
      const expiresAt = new Date(announcement.expires_at);
      if (now > expiresAt) continue; // Expired
    }

    // Check version range (skip for web target)
    if (!isWeb) {
      if (!isWithinVersionRange(appVersion, announcement.min_app_version, announcement.max_app_version)) {
        continue;
      }
    }

    // Check dismissal status based on priority
    if (announcement.priority === 'forced') {
      // Forced announcements always show
      eligibleAnnouncements.push(announcement);
    } else if (announcement.priority === 'important') {
      // Important: ignores global skip, respects per-ID dismissal
      if (announcement.show_once) {
        const dismissed = await isAnnouncementDismissed(announcement.id);
        if (dismissed) continue;
      }
      eligibleAnnouncements.push(announcement);
    } else {
      // Normal: respects global skip preference AND per-ID dismissal
      if (skipNormalAnnouncements) continue;

      if (announcement.show_once) {
        const dismissed = await isAnnouncementDismissed(announcement.id);
        if (dismissed) continue;
      }
      eligibleAnnouncements.push(announcement);
    }
  }

  // Sort by priority (forced first), then by date (newest first)
  eligibleAnnouncements.sort((a, b) => {
    const priorityDiff = getPriorityOrder(a.priority) - getPriorityOrder(b.priority);
    if (priorityDiff !== 0) return priorityDiff;

    // Same priority, sort by date (newest first)
    return new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime();
  });

  return eligibleAnnouncements;
}
