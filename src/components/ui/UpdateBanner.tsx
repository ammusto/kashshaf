interface UpdateBannerProps {
  remoteVersion: string | null;
  onUpdate: () => void;
  onDismiss: () => void;
}

export function UpdateBanner({ remoteVersion, onUpdate, onDismiss }: UpdateBannerProps) {
  return (
    <div className="bg-app-accent-light px-4 py-2 flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <svg className="w-5 h-5 text-app-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
          />
        </svg>
        <span className="text-sm text-app-text-primary">
          New corpus version available{remoteVersion ? ` (${remoteVersion})` : ''}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onUpdate}
          className="px-3 py-1 text-sm rounded-md bg-app-accent text-white hover:bg-app-accent-dark transition-colors"
        >
          Update
        </button>
        <button
          onClick={onDismiss}
          className="p-1 rounded-md text-app-text-secondary hover:bg-app-surface-variant transition-colors"
          title="Dismiss"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
