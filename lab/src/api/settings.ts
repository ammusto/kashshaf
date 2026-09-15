/**
 * Settings that live in `lab_setting` and are read by more than one panel.
 *
 * The heavy-run thresholds (spec 1.5 §F4) are the first of these: the isnād
 * extractor, book-mode reuse and Qurʾān detection each warn before a run
 * larger than them, and Settings is where the reader moves them.
 */

import { useCallback, useEffect, useState } from 'react';
import { labApi } from './lab';
import { DEFAULT_HEAVY_LIMITS, type HeavyLimits } from '../components/ui/Running';

export const HEAVY_LIMITS_KEY = 'heavy_limits';

export function parseHeavyLimits(json: string | null): HeavyLimits {
  if (!json) return DEFAULT_HEAVY_LIMITS;
  try {
    const v = JSON.parse(json) as Partial<HeavyLimits>;
    const tokens = Number(v.tokens);
    const pages = Number(v.pages);
    return {
      tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : DEFAULT_HEAVY_LIMITS.tokens,
      pages: Number.isFinite(pages) && pages > 0 ? pages : DEFAULT_HEAVY_LIMITS.pages,
    };
  } catch {
    return DEFAULT_HEAVY_LIMITS;
  }
}

/**
 * The thresholds, kept in sync with the database. Panels read them; Settings
 * writes them. Until the first read returns, the shipped defaults apply —
 * warning too eagerly is better than starting an hour-long run unasked.
 */
export function useHeavyLimits(): { limits: HeavyLimits; save: (l: HeavyLimits) => Promise<void> } {
  const [limits, setLimits] = useState<HeavyLimits>(DEFAULT_HEAVY_LIMITS);

  useEffect(() => {
    let live = true;
    labApi
      .getSetting(HEAVY_LIMITS_KEY)
      .then((v) => live && setLimits(parseHeavyLimits(v)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const save = useCallback(async (l: HeavyLimits) => {
    setLimits(l);
    await labApi.setSetting(HEAVY_LIMITS_KEY, JSON.stringify(l));
  }, []);

  return { limits, save };
}
