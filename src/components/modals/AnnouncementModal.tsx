import { useState } from 'react';
import type { Announcement } from '../../types';

interface AnnouncementModalProps {
  announcement: Announcement;
  onDismiss: (doNotShowAgain: boolean) => void;
}

/**
 * Get header color classes based on announcement type
 */
function getTypeStyles(type: Announcement['type']): { bg: string; text: string; border: string } {
  switch (type) {
    case 'critical':
      return {
        bg: 'bg-red-50',
        text: 'text-red-700',
        border: 'border-red-200',
      };
    case 'warning':
      return {
        bg: 'bg-yellow-50',
        text: 'text-yellow-700',
        border: 'border-yellow-200',
      };
    case 'info':
    default:
      return {
        bg: 'bg-blue-50',
        text: 'text-blue-700',
        border: 'border-blue-200',
      };
  }
}

/**
 * Get icon based on announcement type
 */
function TypeIcon({ type }: { type: Announcement['type'] }) {
  switch (type) {
    case 'critical':
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      );
    case 'warning':
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case 'info':
    default:
      return (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
  }
}

/**
 * Render body content with basic markdown support (newlines)
 */
function renderBody(body: string, format: Announcement['body_format']): React.ReactNode {
  if (format === 'markdown') {
    // Split by newlines and render as paragraphs
    const lines = body.split('\n');
    return (
      <div className="space-y-2">
        {lines.map((line, index) => {
          if (line.trim() === '') {
            return <div key={index} className="h-2" />;
          }
          return (
            <p key={index} className="text-app-text-secondary">
              {line}
            </p>
          );
        })}
      </div>
    );
  }

  // Plain text - just handle newlines
  const lines = body.split('\n');
  return (
    <div className="space-y-2">
      {lines.map((line, index) => {
        if (line.trim() === '') {
          return <div key={index} className="h-2" />;
        }
        return (
          <p key={index} className="text-app-text-secondary">
            {line}
          </p>
        );
      })}
    </div>
  );
}

export function AnnouncementModal({ announcement, onDismiss }: AnnouncementModalProps) {
  const [doNotShowAgain, setDoNotShowAgain] = useState(false);

  const typeStyles = getTypeStyles(announcement.type);

  // For forced + non-dismissible, user must take action
  const canDismiss = announcement.dismissible;
  const showDoNotShowAgain = announcement.dismissible && announcement.priority !== 'forced';

  const handleClose = () => {
    if (canDismiss) {
      onDismiss(doNotShowAgain);
    }
  };

  const handleAction = () => {
    if (announcement.action?.url) {
      window.open(announcement.action.url, '_blank', 'noopener,noreferrer');
    }
    // After taking action, dismiss the modal
    onDismiss(doNotShowAgain);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl w-[500px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className={`flex items-center gap-3 px-6 py-4 border-b ${typeStyles.border} ${typeStyles.bg}`}>
          <div className={typeStyles.text}>
            <TypeIcon type={announcement.type} />
          </div>
          <h2 className={`text-lg font-semibold flex-1 ${typeStyles.text}`}>
            {announcement.title}
          </h2>
          {canDismiss && (
            <button
              onClick={handleClose}
              className="p-2 rounded-lg hover:bg-white/50 transition-colors"
            >
              <svg className="w-5 h-5 text-app-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {renderBody(announcement.body, announcement.body_format)}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-app-border-light">
          {/* Do not show again checkbox */}
          {showDoNotShowAgain && (
            <label className="flex items-center gap-2 text-sm text-app-text-tertiary cursor-pointer mb-4">
              <input
                type="checkbox"
                checked={doNotShowAgain}
                onChange={(e) => setDoNotShowAgain(e.target.checked)}
                className="w-4 h-4 rounded border-app-border-light"
              />
              <span>Do not show again</span>
            </label>
          )}

          <div className="flex justify-end gap-3">
            {/* Close button - only if dismissible */}
            {canDismiss && (
              <button
                onClick={handleClose}
                className="px-4 py-2 rounded-lg text-app-text-secondary hover:bg-app-surface-variant transition-colors"
              >
                Close
              </button>
            )}

            {/* Action button */}
            {announcement.action && (
              <button
                onClick={handleAction}
                className="px-4 py-2 rounded-lg bg-app-accent text-white hover:bg-app-accent-dark transition-colors"
              >
                {announcement.action.label}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
