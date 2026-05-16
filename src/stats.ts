/**
 * stats.ts — pure helpers for the session-stats feature.
 *
 * The truth lives in chrome.storage.local.stats; this module never touches
 * storage. background.ts owns the read/modify/write transaction, popup and
 * options just observe. Keeping these pure means we can test them under
 * Node's built-in test runner without faking chrome.* APIs.
 *
 * Design: docs/design-session-stats.md.
 */

import type { DailyStat, Stats } from "./storage";

/** Default ceiling on how many days we retain in `stats.daily`. */
export const DEFAULT_KEEP_DAYS = 100;

/** Minimum elapsed time on a skipped work session for it to count. */
export const MIN_SKIP_FOCUS_MS = 60_000;

/**
 * Local-date YYYY-MM-DD key for the given epoch ms.
 *
 * Uses the runtime's local time so day boundaries follow the user's wall
 * clock — a session ending at 00:25 lands on the new day's bucket, matching
 * what the user perceives.
 */
export function localDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function emptyDay(): DailyStat {
  return { focus_min: 0, sessions: 0 };
}

/**
 * Add one completed work session to the stats snapshot. Returns a new Stats
 * value; the input is left untouched so callers can compare or rollback.
 *
 * - focusMs < MIN_SKIP_FOCUS_MS is treated as not-a-completion (no mutation).
 *   The decision *what* counts as completion lives in background.ts; this is
 *   the floor we apply uniformly regardless of caller path.
 * - focus_min uses floor(ms/60_000) so a 24:30 → 24 min recording is honest
 *   about partial minutes.
 */
export function recordWorkCompletion(
  stats: Stats,
  focusMs: number,
  endTs: number,
): Stats {
  if (!Number.isFinite(focusMs) || focusMs < MIN_SKIP_FOCUS_MS) return stats;
  const minutes = Math.floor(focusMs / 60_000);
  if (minutes <= 0) return stats;
  const key = localDateKey(endTs);
  const prev = stats.daily[key] ?? emptyDay();
  const nextDaily: Record<string, DailyStat> = {
    ...stats.daily,
    [key]: {
      focus_min: prev.focus_min + minutes,
      sessions: prev.sessions + 1,
    },
  };
  return {
    daily: nextDaily,
    total_focus_min: stats.total_focus_min + minutes,
    total_sessions: stats.total_sessions + 1,
  };
}

/**
 * Drop daily entries older than `keepDays`, anchored at `today` (default: now).
 *
 * Pruned minutes/sessions stay in `total_*` so the lifetime counters survive
 * retention. This keeps the storage bounded (~100 entries × small payload)
 * without ever silently shrinking the user's lifetime total.
 */
export function pruneOldDays(
  stats: Stats,
  keepDays: number = DEFAULT_KEEP_DAYS,
  today: number = Date.now(),
): Stats {
  if (!Number.isFinite(keepDays) || keepDays <= 0) return stats;
  const cutoff = new Date(today);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (keepDays - 1));
  const cutoffKey = localDateKey(cutoff.getTime());
  const nextDaily: Record<string, DailyStat> = {};
  let changed = false;
  for (const [key, day] of Object.entries(stats.daily)) {
    if (key >= cutoffKey) {
      nextDaily[key] = day;
    } else {
      changed = true;
    }
  }
  if (!changed) return stats;
  return { ...stats, daily: nextDaily };
}

/** Rebuild `total_*` from `daily`. Use sparingly — only when totals are suspect. */
export function recomputeTotals(stats: Stats): Stats {
  let focus = 0;
  let sessions = 0;
  for (const day of Object.values(stats.daily)) {
    focus += day.focus_min;
    sessions += day.sessions;
  }
  return { ...stats, total_focus_min: focus, total_sessions: sessions };
}

/**
 * Return the last `n` days ending at `today`, oldest first, missing days
 * zero-filled. Useful for the options page bar chart so it can render a
 * stable-width track regardless of how sparse the user's history is.
 */
export function lastNDays(
  stats: Stats,
  n: number,
  today: number = Date.now(),
): Array<{ date: string; focus_min: number; sessions: number }> {
  if (!Number.isFinite(n) || n <= 0) return [];
  const out: Array<{ date: string; focus_min: number; sessions: number }> = [];
  const base = new Date(today);
  base.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    const key = localDateKey(d.getTime());
    const day = stats.daily[key];
    out.push({
      date: key,
      focus_min: day?.focus_min ?? 0,
      sessions: day?.sessions ?? 0,
    });
  }
  return out;
}
