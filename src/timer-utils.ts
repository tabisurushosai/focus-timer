/**
 * timer-utils.ts — pure helpers shared by background.ts (truth) and popup.ts
 * (view).
 *
 * No DOM, no chrome.*, no I/O. Keeping the phase math in one place prevents
 * drift between the service worker that mutates state and the popup that
 * renders it.
 */

import type { Settings, TimerMode, TimerState } from "./storage";

export type ModeMessageKey =
  | "popup_mode_work"
  | "popup_mode_break"
  | "popup_mode_long_break";

/** Total duration for a phase in ms, clamped so a misconfigured 0 never stalls the timer. */
export function totalForMode(mode: TimerMode, settings: Settings): number {
  const minutes =
    mode === "break"
      ? settings.break_min
      : mode === "long_break"
        ? settings.long_break_min
        : settings.work_min;
  return Math.max(1, minutes) * 60_000;
}

/**
 * Decide which phase follows the current one.
 *
 * `completedWorkSessions` is the running count *including* the work session
 * that just finished — so the cadence check fires on every Nth completion.
 */
export function nextMode(
  mode: TimerMode,
  completedWorkSessions: number,
  settings: Settings,
): TimerMode {
  if (mode === "work") {
    const cadence = Math.max(1, settings.sessions_until_long_break);
    return completedWorkSessions % cadence === 0 ? "long_break" : "break";
  }
  return "work";
}

/** mm:ss for any non-negative ms duration. Negative inputs are clamped to 0. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/**
 * Compute the live remaining ms for a TimerState.
 *
 * Running: derived from absolute end_ts so the value is correct after the
 *   service worker is recycled or the popup is reopened.
 * Paused/idle: the stored remaining_ms is authoritative.
 */
export function currentRemainingMs(
  timer: TimerState,
  now: number = Date.now(),
): number {
  if (timer.running && timer.end_ts > 0) {
    return Math.max(0, timer.end_ts - now);
  }
  return Math.max(0, timer.remaining_ms);
}

/** i18n message key for a phase label. */
export function modeKey(mode: TimerMode): ModeMessageKey {
  if (mode === "break") return "popup_mode_break";
  if (mode === "long_break") return "popup_mode_long_break";
  return "popup_mode_work";
}

/**
 * Stroke-dashoffset for an SVG ring of the given circumference.
 *
 * `remaining/total` is clamped to [0,1] so a transient drift (end_ts slightly
 * past now, or remaining_ms briefly exceeding total after a settings change)
 * does not produce a negative offset that would invert the ring.
 */
export function progressDashOffset(
  remainingMs: number,
  totalMs: number,
  circumference: number,
): number {
  if (totalMs <= 0) return circumference;
  const ratio = remainingMs / totalMs;
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return circumference * (1 - clamped);
}
