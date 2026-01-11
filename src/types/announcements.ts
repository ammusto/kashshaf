// Announcement Types for CDN-delivered announcements system

/** Target platform for an announcement */
export type TargetPlatform = 'all' | 'desktop' | 'web';

/** Type/severity of an announcement */
export type AnnouncementType = 'info' | 'warning' | 'critical';

/** Priority level determining dismissal behavior */
export type AnnouncementPriority = 'normal' | 'important' | 'forced';

/** Body format for rendering */
export type AnnouncementBodyFormat = 'text' | 'markdown';

/** Optional action button for an announcement */
export interface AnnouncementAction {
  label: string;
  url: string;
}

/** Single announcement from CDN */
export interface Announcement {
  id: string;
  title: string;
  body: string;
  body_format: AnnouncementBodyFormat;
  type: AnnouncementType;
  priority: AnnouncementPriority;
  target: TargetPlatform;
  min_app_version: string | null;
  max_app_version: string | null;
  starts_at: string; // ISO date
  expires_at: string | null; // ISO date
  dismissible: boolean;
  show_once: boolean;
  action: AnnouncementAction | null;
}

/** CDN response schema */
export interface AnnouncementsManifest {
  schema_version: number;
  announcements: Announcement[];
}

/** Record of a dismissed announcement */
export interface DismissedAnnouncement {
  id: string;
  dismissed_at: string; // ISO date
}

/** Cache structure for announcements */
export interface AnnouncementsCache {
  data: AnnouncementsManifest;
  fetched_at: string; // ISO date
}
