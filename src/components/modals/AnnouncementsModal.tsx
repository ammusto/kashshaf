import { useState, useMemo } from 'react';
import type { Announcement } from '../../types';

interface AnnouncementsModalProps {
  announcements: Announcement[];
  onDismiss: (skipFuturePopups: boolean, dismissedIds: string[]) => void;
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function getTypeBadge(type: Announcement['type']): { label: string; bgColor: string; textColor: string } {
  switch (type) {
    case 'critical':
      return { label: 'Critical', bgColor: 'bg-red-100', textColor: 'text-red-700' };
    case 'warning':
      return { label: 'Warning', bgColor: 'bg-yellow-100', textColor: 'text-yellow-700' };
    case 'info':
    default:
      return { label: 'Info', bgColor: 'bg-blue-100', textColor: 'text-blue-700' };
  }
}

function renderBody(body: string, format: Announcement['body_format']): React.ReactNode {
  if (format === 'markdown') {
    // Simple markdown rendering for common patterns
    // For now, just handle newlines, bold, and links
    const lines = body.split('\n');
    return lines.map((line, i) => {
      // Handle bold: **text**
      let processed: React.ReactNode = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

      // Handle links: [text](url)
      processed = (processed as string).replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-app-accent hover:underline">$1</a>'
      );

      return (
        <span key={i}>
          <span dangerouslySetInnerHTML={{ __html: processed as string }} />
          {i < lines.length - 1 && <br />}
        </span>
      );
    });
  }

  // Plain text: just handle newlines
  return body.split('\n').map((line, i, arr) => (
    <span key={i}>
      {line}
      {i < arr.length - 1 && <br />}
    </span>
  ));
}

export function AnnouncementsModal({ announcements, onDismiss }: AnnouncementsModalProps) {
  const [skipFuturePopups, setSkipFuturePopups] = useState(false);

  // Check if any announcement is forced and non-dismissible
  const hasNonDismissibleForced = useMemo(() => {
    return announcements.some(a => a.priority === 'forced' && !a.dismissible);
  }, [announcements]);

  // Get all dismissible announcement IDs
  const dismissibleIds = useMemo(() => {
    return announcements
      .filter(a => a.dismissible || a.priority !== 'forced')
      .map(a => a.id);
  }, [announcements]);

  const handleDismiss = () => {
    onDismiss(skipFuturePopups, dismissibleIds);
  };

  const handleActionClick = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  if (announcements.length === 0) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-app-border-light">
          <h2 className="text-lg font-semibold text-app-text-primary">Announcements</h2>
          {!hasNonDismissibleForced && (
            <button
              onClick={handleDismiss}
              className="p-2 rounded-lg hover:bg-app-surface-variant transition-colors"
            >
              <svg className="w-5 h-5 text-app-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Content - Scrollable */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {announcements.map(announcement => {
            const badge = getTypeBadge(announcement.type);

            return (
              <div
                key={announcement.id}
                className={`p-4 rounded-lg border ${
                  announcement.type === 'critical'
                    ? 'border-red-200 bg-red-50'
                    : announcement.type === 'warning'
                    ? 'border-yellow-200 bg-yellow-50'
                    : 'border-app-border-light bg-app-surface-variant'
                }`}
              >
                {/* Card Header */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.bgColor} ${badge.textColor}`}>
                      {badge.label}
                    </span>
                    <span className="text-xs text-app-text-tertiary">
                      {formatDate(announcement.starts_at)}
                    </span>
                  </div>
                  {announcement.priority === 'forced' && (
                    <span className="text-xs text-app-text-tertiary italic">Required</span>
                  )}
                </div>

                {/* Title */}
                <h3 className="text-base font-semibold text-app-text-primary mb-2">
                  {announcement.title}
                </h3>

                {/* Body */}
                <div className="text-sm text-app-text-secondary mb-3 leading-relaxed">
                  {renderBody(announcement.body, announcement.body_format)}
                </div>

                {/* Action Button */}
                {announcement.action && (
                  <button
                    onClick={() => handleActionClick(announcement.action!.url)}
                    className="px-4 py-2 rounded-lg bg-app-accent text-white text-sm font-medium hover:bg-app-accent-dark transition-colors"
                  >
                    {announcement.action.label}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        {!hasNonDismissibleForced && (
          <div className="px-6 py-4 border-t border-app-border-light">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-app-text-tertiary cursor-pointer">
                <input
                  type="checkbox"
                  checked={skipFuturePopups}
                  onChange={(e) => setSkipFuturePopups(e.target.checked)}
                  className="w-4 h-4 rounded border-app-border-light"
                />
                <span>Don't show on startup</span>
              </label>

              <button
                onClick={handleDismiss}
                className="px-4 py-2 rounded-lg bg-app-accent text-white hover:bg-app-accent-dark transition-colors"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
