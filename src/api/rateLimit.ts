/**
 * The client's side of the server's rate limit.
 *
 * A 429 says how long to wait in `Retry-After`. The request that got it
 * waits that long and tries again, and every other request holds back until
 * the same moment rather than piling on; meanwhile the app shows a quiet
 * note (RateLimitIndicator) instead of an error. Nothing here is specific to
 * a route; the online API's `fetchAPI` calls it for every request.
 */

export interface RateLimitState {
  /** Epoch ms until which requests are held back; 0 when not throttled. */
  throttledUntil: number;
  /** 429s seen since the page loaded, for the rate-limit test and diagnostics. */
  hits: number;
}

let state: RateLimitState = { throttledUntil: 0, hits: 0 };
const listeners = new Set<() => void>();

function emit(next: RateLimitState) {
  state = next;
  for (const l of listeners) l();
}

export function getRateLimitState(): RateLimitState {
  return state;
}

export function subscribeRateLimit(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The wait a 429 asked for, in ms: `Retry-After` seconds, else one second, at most 30. */
export function retryAfterMs(header: string | null): number {
  const seconds = header ? Number(header) : NaN;
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000;
  return Math.min(ms, 30_000);
}

/** A 429 arrived: hold every request until `now + waitMs`. */
export function noteRateLimited(waitMs: number): void {
  const until = Date.now() + waitMs;
  emit({ throttledUntil: Math.max(state.throttledUntil, until), hits: state.hits + 1 });
  // Clear the indicator when the wait is over (a request may not come to do it).
  setTimeout(() => {
    if (Date.now() >= state.throttledUntil) emit({ ...state, throttledUntil: 0 });
  }, waitMs + 20);
}

/** Wait out a hold in progress, if any, before sending a request. */
export async function waitIfThrottled(): Promise<void> {
  const wait = state.throttledUntil - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** For tests: back to the start. */
export function resetRateLimit(): void {
  emit({ throttledUntil: 0, hits: 0 });
}
