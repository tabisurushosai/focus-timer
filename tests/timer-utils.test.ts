/**
 * Tests for src/timer-utils.ts — the pure phase/format helpers shared between
 * the service worker (truth) and the popup (view).
 *
 * Run with: npm test (uses Node's built-in --test + --experimental-strip-types).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Settings, TimerState } from "../src/storage.ts";
import {
  currentRemainingMs,
  formatTime,
  modeKey,
  nextMode,
  progressDashOffset,
  totalForMode,
} from "../src/timer-utils.ts";

const baseSettings: Settings = {
  work_min: 25,
  break_min: 5,
  long_break_min: 15,
  sessions_until_long_break: 4,
  auto_start_break: false,
  auto_start_work: false,
  theme: "system",
  sound_enabled: true,
  sound_volume: 0.6,
  notification_enabled: true,
  break_reminder_enabled: true,
  child_mode: false,
  language: "auto",
};

const baseTimer: TimerState = {
  mode: "work",
  running: false,
  end_ts: 0,
  remaining_ms: 25 * 60_000,
  session_count: 0,
};

describe("totalForMode", () => {
  it("returns work/break/long_break in ms", () => {
    assert.equal(totalForMode("work", baseSettings), 25 * 60_000);
    assert.equal(totalForMode("break", baseSettings), 5 * 60_000);
    assert.equal(totalForMode("long_break", baseSettings), 15 * 60_000);
  });

  it("clamps zero/negative minutes to one minute so the timer never stalls", () => {
    const broken: Settings = { ...baseSettings, work_min: 0, break_min: -3 };
    assert.equal(totalForMode("work", broken), 60_000);
    assert.equal(totalForMode("break", broken), 60_000);
  });
});

describe("nextMode", () => {
  it("after a work session: short break unless cadence hits, then long break", () => {
    // sessions_until_long_break=4 → completed counts 1,2,3 → break; 4 → long_break
    assert.equal(nextMode("work", 1, baseSettings), "break");
    assert.equal(nextMode("work", 2, baseSettings), "break");
    assert.equal(nextMode("work", 3, baseSettings), "break");
    assert.equal(nextMode("work", 4, baseSettings), "long_break");
    assert.equal(nextMode("work", 8, baseSettings), "long_break");
  });

  it("after any break: back to work", () => {
    assert.equal(nextMode("break", 99, baseSettings), "work");
    assert.equal(nextMode("long_break", 99, baseSettings), "work");
  });

  it("treats cadence <= 0 as 1 so every work session leads to a long break", () => {
    const cfg: Settings = { ...baseSettings, sessions_until_long_break: 0 };
    assert.equal(nextMode("work", 1, cfg), "long_break");
    assert.equal(nextMode("work", 2, cfg), "long_break");
  });
});

describe("formatTime", () => {
  it("formats whole minutes and seconds with zero padding", () => {
    assert.equal(formatTime(25 * 60_000), "25:00");
    assert.equal(formatTime(5 * 60_000 + 7_000), "05:07");
    assert.equal(formatTime(59_000), "00:59");
  });

  it("rounds to the nearest second", () => {
    assert.equal(formatTime(1_499), "00:01");
    assert.equal(formatTime(1_500), "00:02");
  });

  it("clamps negative input to 00:00", () => {
    assert.equal(formatTime(-1_000), "00:00");
    assert.equal(formatTime(0), "00:00");
  });
});

describe("currentRemainingMs", () => {
  it("running: derived from end_ts so reopening the popup shows live time", () => {
    const now = 10_000_000;
    const timer: TimerState = {
      ...baseTimer,
      running: true,
      end_ts: now + 90_000,
      remaining_ms: 0,
    };
    assert.equal(currentRemainingMs(timer, now), 90_000);
    assert.equal(currentRemainingMs(timer, now + 30_000), 60_000);
  });

  it("running but end_ts already passed: returns 0, never negative", () => {
    const now = 10_000_000;
    const timer: TimerState = {
      ...baseTimer,
      running: true,
      end_ts: now - 5_000,
      remaining_ms: 0,
    };
    assert.equal(currentRemainingMs(timer, now), 0);
  });

  it("paused: uses stored remaining_ms regardless of now", () => {
    const timer: TimerState = {
      ...baseTimer,
      running: false,
      end_ts: 0,
      remaining_ms: 7_777,
    };
    assert.equal(currentRemainingMs(timer, 999_999), 7_777);
  });
});

describe("modeKey", () => {
  it("maps each phase to its i18n key", () => {
    assert.equal(modeKey("work"), "popup_mode_work");
    assert.equal(modeKey("break"), "popup_mode_break");
    assert.equal(modeKey("long_break"), "popup_mode_long_break");
  });
});

describe("progressDashOffset", () => {
  const C = 2 * Math.PI * 92;

  it("full ring at start (remaining === total) → offset 0", () => {
    assert.equal(progressDashOffset(60_000, 60_000, C), 0);
  });

  it("empty ring at end (remaining === 0) → offset === circumference", () => {
    assert.equal(progressDashOffset(0, 60_000, C), C);
  });

  it("half remaining → offset is half the circumference", () => {
    assert.ok(Math.abs(progressDashOffset(30_000, 60_000, C) - C / 2) < 1e-9);
  });

  it("clamps overflow so a transient remaining > total does not invert the ring", () => {
    assert.equal(progressDashOffset(120_000, 60_000, C), 0);
  });

  it("clamps negative so an expired end_ts does not produce > C", () => {
    assert.equal(progressDashOffset(-1_000, 60_000, C), C);
  });

  it("guards against a zero-total config", () => {
    assert.equal(progressDashOffset(0, 0, C), C);
  });
});
