/**
 * Tests for session-stats (T024) — pure-function behavior plus integration
 * checks for the design in docs/design-session-stats.md. Statistics are split
 * across three layers (stats.ts pure helpers, background.ts mutator,
 * popup/options viewers) so this file pins each seam:
 *
 *  - stats.ts contracts (localDateKey, recordWorkCompletion, pruneOldDays,
 *    recomputeTotals, lastNDays) for known and edge inputs
 *  - i18n keys exist in both ja and en locales
 *  - popup.html exposes #focus-min-today, popup.ts reads stats.daily[today]
 *  - background.ts writes stats from both phase-end and skip paths and uses
 *    endTs (not Date.now) for the calendar bucket
 *  - options.html / options.ts wire the 7-day chart, Premium gating, CSV
 *    export, and the destructive clear-all flow
 *
 * Run with: npm test (uses Node's built-in --test + --experimental-strip-types).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  DEFAULT_KEEP_DAYS,
  MIN_SKIP_FOCUS_MS,
  lastNDays,
  localDateKey,
  pruneOldDays,
  recomputeTotals,
  recordWorkCompletion,
} from "../src/stats.ts";
import { DEFAULT_STATS, type Stats } from "../src/storage.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function readText(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

function readJson(rel: string): Record<string, { message: string }> {
  return JSON.parse(readText(rel));
}

/** Build a Stats value with explicit daily entries and recomputed totals. */
function makeStats(daily: Record<string, { focus_min: number; sessions: number }>): Stats {
  return recomputeTotals({
    daily,
    total_focus_min: 0,
    total_sessions: 0,
  });
}

describe("stats: localDateKey", () => {
  it("formats local YYYY-MM-DD with zero padding", () => {
    // Construct via local components so the result is deterministic regardless
    // of the runner's TZ. localDateKey itself reads local components too.
    const d = new Date(2026, 0, 3, 23, 59, 0); // Jan 3 2026, 23:59 local
    assert.equal(localDateKey(d.getTime()), "2026-01-03");
  });

  it("rolls into the next day's bucket once the wall clock crosses midnight", () => {
    const before = new Date(2026, 4, 17, 23, 59, 30).getTime();
    const after = new Date(2026, 4, 18, 0, 0, 30).getTime();
    assert.equal(localDateKey(before), "2026-05-17");
    assert.equal(localDateKey(after), "2026-05-18");
  });
});

describe("stats: recordWorkCompletion", () => {
  const today = new Date(2026, 4, 17, 12, 0, 0).getTime();
  const todayKey = localDateKey(today);

  it("adds floor(focusMs/60000) minutes and +1 session on the endTs date", () => {
    const next = recordWorkCompletion(DEFAULT_STATS, 25 * 60_000 + 30_000, today);
    assert.equal(next.daily[todayKey].focus_min, 25);
    assert.equal(next.daily[todayKey].sessions, 1);
    assert.equal(next.total_focus_min, 25);
    assert.equal(next.total_sessions, 1);
  });

  it("accumulates across multiple completions on the same local day", () => {
    let s = recordWorkCompletion(DEFAULT_STATS, 25 * 60_000, today);
    s = recordWorkCompletion(s, 10 * 60_000, today + 60_000);
    assert.equal(s.daily[todayKey].focus_min, 35);
    assert.equal(s.daily[todayKey].sessions, 2);
    assert.equal(s.total_focus_min, 35);
    assert.equal(s.total_sessions, 2);
  });

  it("ignores skips that did not cross the MIN_SKIP_FOCUS_MS floor", () => {
    const next = recordWorkCompletion(DEFAULT_STATS, MIN_SKIP_FOCUS_MS - 1, today);
    assert.strictEqual(next, DEFAULT_STATS, "should be a no-op (same reference)");
  });

  it("treats a session with < 1 full minute as not-a-completion", () => {
    // Exactly MIN_SKIP_FOCUS_MS rounds down to 1 minute → does count.
    const next = recordWorkCompletion(DEFAULT_STATS, MIN_SKIP_FOCUS_MS, today);
    assert.equal(next.daily[todayKey].focus_min, 1);
    assert.equal(next.daily[todayKey].sessions, 1);
  });

  it("buckets by endTs's local date, not the receiver's clock", () => {
    const lateNight = new Date(2026, 4, 17, 23, 55, 0).getTime();
    const justAfterMidnight = new Date(2026, 4, 18, 0, 25, 0).getTime();
    const s1 = recordWorkCompletion(DEFAULT_STATS, 30 * 60_000, lateNight);
    const s2 = recordWorkCompletion(s1, 30 * 60_000, justAfterMidnight);
    assert.equal(s2.daily["2026-05-17"]?.focus_min, 30);
    assert.equal(s2.daily["2026-05-18"]?.focus_min, 30);
    assert.equal(s2.total_focus_min, 60);
    assert.equal(s2.total_sessions, 2);
  });

  it("does not mutate the input stats", () => {
    const before: Stats = { daily: {}, total_focus_min: 0, total_sessions: 0 };
    const frozen = Object.freeze({ ...before, daily: Object.freeze({ ...before.daily }) });
    const next = recordWorkCompletion(frozen as Stats, 25 * 60_000, today);
    assert.notStrictEqual(next, frozen);
    assert.equal(Object.keys(frozen.daily).length, 0);
  });

  it("ignores non-finite focusMs without throwing", () => {
    assert.strictEqual(recordWorkCompletion(DEFAULT_STATS, NaN, today), DEFAULT_STATS);
    assert.strictEqual(
      recordWorkCompletion(DEFAULT_STATS, Number.POSITIVE_INFINITY, today),
      DEFAULT_STATS,
    );
  });
});

describe("stats: pruneOldDays", () => {
  it("keeps the last N days (inclusive of today) and drops older entries", () => {
    const today = new Date(2026, 4, 17, 12, 0, 0).getTime();
    const stats = makeStats({
      "2026-05-17": { focus_min: 25, sessions: 1 },
      "2026-05-15": { focus_min: 50, sessions: 2 },
      "2026-05-10": { focus_min: 75, sessions: 3 },
    });
    const pruned = pruneOldDays(stats, 7, today);
    assert.ok(pruned.daily["2026-05-17"], "today must be kept");
    assert.ok(pruned.daily["2026-05-15"], "within 7d must be kept");
    assert.equal(pruned.daily["2026-05-10"], undefined, "older than 7d must be dropped");
  });

  it("retains total_* even when daily entries are pruned (lifetime survives)", () => {
    const today = new Date(2026, 4, 17, 12, 0, 0).getTime();
    const stats = makeStats({
      "2026-05-17": { focus_min: 25, sessions: 1 },
      "2026-01-01": { focus_min: 100, sessions: 4 },
    });
    const pruned = pruneOldDays(stats, 7, today);
    assert.equal(pruned.daily["2026-01-01"], undefined);
    assert.equal(pruned.total_focus_min, 125, "total_focus_min stays after prune");
    assert.equal(pruned.total_sessions, 5, "total_sessions stays after prune");
  });

  it("returns the same reference when nothing was pruned (no spurious writes)", () => {
    const today = new Date(2026, 4, 17, 12, 0, 0).getTime();
    const stats = makeStats({ "2026-05-17": { focus_min: 25, sessions: 1 } });
    assert.strictEqual(pruneOldDays(stats, 7, today), stats);
  });

  it("treats keepDays <= 0 or non-finite as a no-op", () => {
    const stats = makeStats({ "2026-05-17": { focus_min: 25, sessions: 1 } });
    assert.strictEqual(pruneOldDays(stats, 0), stats);
    assert.strictEqual(pruneOldDays(stats, -3), stats);
    assert.strictEqual(pruneOldDays(stats, NaN), stats);
  });

  it("default keep window is 100 days (matches DEFAULT_KEEP_DAYS)", () => {
    assert.equal(DEFAULT_KEEP_DAYS, 100);
  });
});

describe("stats: recomputeTotals", () => {
  it("rebuilds total_* from daily values", () => {
    const stats: Stats = {
      daily: {
        "2026-05-15": { focus_min: 25, sessions: 1 },
        "2026-05-16": { focus_min: 50, sessions: 2 },
        "2026-05-17": { focus_min: 10, sessions: 1 },
      },
      total_focus_min: 0,
      total_sessions: 0,
    };
    const next = recomputeTotals(stats);
    assert.equal(next.total_focus_min, 85);
    assert.equal(next.total_sessions, 4);
  });

  it("zeros the totals when daily is empty", () => {
    const next = recomputeTotals(DEFAULT_STATS);
    assert.equal(next.total_focus_min, 0);
    assert.equal(next.total_sessions, 0);
  });
});

describe("stats: lastNDays", () => {
  it("returns oldest→newest with zero-filled gaps", () => {
    const today = new Date(2026, 4, 17, 12, 0, 0).getTime();
    const stats = makeStats({
      "2026-05-17": { focus_min: 25, sessions: 1 },
      "2026-05-15": { focus_min: 50, sessions: 2 },
    });
    const rows = lastNDays(stats, 7, today);
    assert.equal(rows.length, 7);
    assert.equal(rows[0].date, "2026-05-11", "first row is 6 days before today");
    assert.equal(rows[6].date, "2026-05-17", "last row is today");
    assert.deepEqual(rows[2], { date: "2026-05-13", focus_min: 0, sessions: 0 });
    assert.deepEqual(rows[4], { date: "2026-05-15", focus_min: 50, sessions: 2 });
    assert.deepEqual(rows[6], { date: "2026-05-17", focus_min: 25, sessions: 1 });
  });

  it("supports 30 and 90 day windows (Premium ranges)", () => {
    const today = new Date(2026, 4, 17, 12, 0, 0).getTime();
    const rows30 = lastNDays(DEFAULT_STATS, 30, today);
    const rows90 = lastNDays(DEFAULT_STATS, 90, today);
    assert.equal(rows30.length, 30);
    assert.equal(rows90.length, 90);
    assert.equal(rows30[rows30.length - 1].date, "2026-05-17");
    assert.equal(rows90[rows90.length - 1].date, "2026-05-17");
  });

  it("returns [] for n <= 0 or non-finite", () => {
    assert.deepEqual(lastNDays(DEFAULT_STATS, 0), []);
    assert.deepEqual(lastNDays(DEFAULT_STATS, -1), []);
    assert.deepEqual(lastNDays(DEFAULT_STATS, NaN), []);
  });
});

const STATS_I18N_KEYS = [
  "popup_focus_min_today",
  "options_stats_7days_title",
  "options_stats_30days_title",
  "options_stats_90days_title",
  "options_stats_premium_title",
  "options_stats_total_focus_min",
  "options_stats_total_sessions",
  "options_stats_clear",
  "options_stats_clear_confirm_title",
  "options_stats_clear_confirm_body",
  "options_stats_export_csv",
  "options_stats_premium_upgrade",
  "options_stats_empty",
  "options_stats_row_label",
  "options_stats_minutes_unit",
  "options_stats_sessions_unit",
  "options_stats_tab_30",
  "options_stats_tab_90",
] as const;

describe("session-stats: i18n keys", () => {
  const ja = readJson("_locales/ja/messages.json");
  const en = readJson("_locales/en/messages.json");

  for (const key of STATS_I18N_KEYS) {
    it(`ja has a non-empty message for ${key}`, () => {
      assert.ok(ja[key], `missing ja key: ${key}`);
      assert.ok(
        typeof ja[key].message === "string" && ja[key].message.length > 0,
        `empty ja message for ${key}`,
      );
    });
    it(`en has a non-empty message for ${key}`, () => {
      assert.ok(en[key], `missing en key: ${key}`);
      assert.ok(
        typeof en[key].message === "string" && en[key].message.length > 0,
        `empty en message for ${key}`,
      );
    });
  }
});

describe("session-stats: popup wiring", () => {
  const html = readText("src/popup.html");
  const src = readText("src/popup.ts");

  it("popup.html exposes #focus-min-today with the i18n label", () => {
    assert.match(html, /id="focus-min-today"/);
    assert.match(html, /data-i18n="popup_focus_min_today"/);
  });

  it("popup.html keeps the existing #session-count meta row", () => {
    assert.match(html, /id="session-count"/);
    assert.match(html, /data-i18n="popup_session_count"/);
  });

  it("popup.ts imports localDateKey from ./stats (not toISOString-on-UTC)", () => {
    assert.match(src, /import\s*\{\s*localDateKey\s*\}\s*from\s*"\.\/stats"/);
    assert.doesNotMatch(
      src,
      /toISOString\(\)\.slice\(0,\s*10\)/,
      "popup must not use UTC date keys",
    );
  });

  it("popup.ts renderStats reads stats.daily[today] for both session count and focus_min", () => {
    assert.match(src, /function renderStats\(stats: Stats\)[\s\S]*?stats\.daily\?\.\[today\]/);
    assert.match(src, /els\.sessionCount\.textContent\s*=\s*String\(todayStats\?\.sessions\s*\?\?\s*0\)/);
    assert.match(src, /els\.focusMinToday\.textContent\s*=\s*String\(todayStats\?\.focus_min\s*\?\?\s*0\)/);
  });

  it("popup.ts re-renders when stats changes via storage onChanged", () => {
    assert.match(src, /"stats"\s+in\s+changes/);
  });
});

describe("session-stats: options wiring", () => {
  const html = readText("src/options.html");
  const src = readText("src/options.ts");

  it("options.html has the 7-day stats container and empty-state hint", () => {
    assert.match(html, /id="stats-7days"[^>]*role="list"/);
    assert.match(html, /id="stats-empty"[^>]*data-i18n="options_stats_empty"/);
  });

  it("options.html has the Premium summary section (hidden by default)", () => {
    assert.match(html, /id="stats-premium"[^>]*hidden/);
    assert.match(html, /id="stats-tab-30"/);
    assert.match(html, /id="stats-tab-90"/);
    assert.match(html, /id="stats-total-focus-min"/);
    assert.match(html, /id="stats-total-sessions"/);
    assert.match(html, /id="btn-export-csv"/);
  });

  it("options.html surfaces the Premium upgrade prompt and the destructive clear button", () => {
    assert.match(html, /id="stats-premium-upgrade"[^>]*data-i18n="options_stats_premium_upgrade"/);
    assert.match(html, /id="btn-clear-stats"[^>]*data-i18n="options_stats_clear"/);
  });

  it("options.ts gates the Premium block on hasPremiumAccess()", () => {
    assert.match(src, /import\s*\{[^}]*hasPremiumAccess[^}]*\}\s*from\s*"\.\/storage"/);
    assert.match(src, /hasPremiumAccess\(\s*premium\s*,\s*now\s*\)/);
    assert.match(src, /els\.statsPremium\.hidden\s*=\s*!premiumOn/);
    assert.match(src, /els\.statsPremiumUpgrade\.hidden\s*=\s*premiumOn/);
  });

  it("options.ts renders the 7-day chart via lastNDays(stats, 7, now)", () => {
    assert.match(src, /lastNDays\(\s*stats\s*,\s*7\s*,\s*now\s*\)/);
  });

  it("options.ts switches the Premium chart between 30 and 90 day ranges", () => {
    assert.match(src, /premiumRange:\s*30\s*\|\s*90/);
    assert.match(src, /premiumRange\s*=\s*30/);
    assert.match(src, /premiumRange\s*=\s*90/);
  });

  it("options.ts clearStats path is gated by a confirm dialog and resets to DEFAULT_STATS", () => {
    // Allow an optional trailing comma after the second key — the call spans
    // multiple lines in options.ts and the formatter adds one.
    assert.match(
      src,
      /async function clearStats\(\)[\s\S]*?confirmAction\(\s*"options_stats_clear_confirm_title"\s*,\s*"options_stats_clear_confirm_body"\s*,?\s*\)/,
    );
    assert.match(src, /chrome\.storage\.local\.set\(\{\s*stats:\s*DEFAULT_STATS\s*\}\)/);
  });

  it("options.ts CSV export uses date,focus_min,sessions header and avoids chrome.downloads", () => {
    assert.match(src, /"date,focus_min,sessions"/);
    assert.match(src, /data:text\/csv/);
    assert.doesNotMatch(
      src,
      /chrome\.downloads/,
      "design says data: URL is preferred so no extra permission is required",
    );
  });
});

describe("session-stats: background wiring", () => {
  const src = readText("src/background.ts");

  it("background imports recordWorkCompletion and pruneOldDays from ./stats", () => {
    assert.match(
      src,
      /import\s*\{[\s\S]*?recordWorkCompletion[\s\S]*?\}\s*from\s*"\.\/stats"/,
    );
    assert.match(src, /pruneOldDays/);
  });

  it("background records on both phase-end AND skip when mode === 'work'", () => {
    // handlePhaseEnd path: full work duration on completion
    assert.match(
      src,
      /handlePhaseEnd[\s\S]*?timer\.mode\s*===\s*"work"[\s\S]*?recordWorkSession\(\s*totalForMode\("work"/,
    );
    // skip path: partial credit (elapsedMs) — recordWorkCompletion enforces the floor
    assert.match(
      src,
      /async function skip\(\)[\s\S]*?timer\.mode\s*===\s*"work"[\s\S]*?recordWorkSession\(\s*elapsedMs\s*,/,
    );
  });

  it("background uses endTs (not Date.now()) so a delayed wake bucket is honest", () => {
    // The alarm boundary lives in timer.end_ts. handlePhaseEnd must thread it
    // through to the stats writer so a sleep/wake delay does not move the
    // completion onto the wrong calendar day.
    assert.match(
      src,
      /const endTs\s*=\s*timer\.end_ts\s*>\s*0\s*\?\s*timer\.end_ts\s*:\s*Date\.now\(\)/,
    );
    assert.match(src, /recordWorkSession\([\s\S]*?endTs\s*\)/);
  });

  it("background prunes after every successful recordWorkCompletion (bounded storage)", () => {
    assert.match(
      src,
      /async function recordWorkSession[\s\S]*?recordWorkCompletion\([\s\S]*?pruneOldDays\(\s*recorded\s*,\s*DEFAULT_KEEP_DAYS/,
    );
  });

  it("background reset() never touches stats", () => {
    const resetBlock = /async function reset\(\)[\s\S]*?clearPhaseAlarm\(\);[\s\S]*?\}/.exec(src)?.[0] ?? "";
    assert.ok(resetBlock.length > 0, "reset() block not found in background.ts");
    assert.doesNotMatch(resetBlock, /recordWorkCompletion|recordWorkSession/);
  });
});
