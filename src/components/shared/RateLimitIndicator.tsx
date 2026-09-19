import { useSyncExternalStore } from 'react';
import { getRateLimitState, subscribeRateLimit } from '../../api/rateLimit';

/**
 * A quiet note while the client is waiting out the server's rate limit.
 * Nothing has failed: the requests are held and sent when the wait is
 * over, so this says so in a corner rather than as an error.
 */
export function RateLimitIndicator() {
  const state = useSyncExternalStore(subscribeRateLimit, getRateLimitState, getRateLimitState);
  if (state.throttledUntil <= Date.now()) return null;
  return (
    <div
      role="status"
      data-testid="rate-limit-indicator"
      className="fixed bottom-3 right-3 z-30 px-3 py-1.5 rounded-full text-xs bg-app-surface-variant text-app-text-secondary border border-app-border-light shadow-app-sm"
    >
      Waiting for the server…
    </div>
  );
}
