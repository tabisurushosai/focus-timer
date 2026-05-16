/**
 * background.ts — Manifest V3 service_worker entry point.
 *
 * Source of truth for the running timer. Holds no in-memory state: every
 * mutation is persisted to chrome.storage.local and the next phase boundary is
 * registered with chrome.alarms so the worker can be torn down and rebuilt
 * without drift. Popup/options observe storage and never compute phase logic.
 */

import {
  DEFAULT_SETTINGS,
  ensureDefaults,
  get,
  patch,
  set,
  type Settings,
  type TimerMode,
  type TimerState,
} from "./storage";
import {
  DEFAULT_KEEP_DAYS,
  pruneOldDays,
  recordWorkCompletion,
} from "./stats";
import { playPhaseTransition } from "./sound";
import { nextMode, totalForMode } from "./timer-utils";

const ALARM_PHASE_END = "focus-timer:phase-end";
const ALARM_BREAK_REMINDER = "focus-timer:break-reminder";

type Command =
  | { type: "timer_start" }
  | { type: "timer_pause" }
  | { type: "timer_resume" }
  | { type: "timer_reset" }
  | { type: "timer_skip" };

async function clearPhaseAlarm(): Promise<void> {
  await chrome.alarms.clear(ALARM_PHASE_END);
}

async function schedulePhaseAlarm(endTs: number): Promise<void> {
  await clearPhaseAlarm();
  await chrome.alarms.create(ALARM_PHASE_END, { when: endTs });
}

async function startOrResume(): Promise<void> {
  const [timer, settings] = await Promise.all([get("timer"), get("settings")]);
  const totalMs = totalForMode(timer.mode, settings);
  const remaining =
    timer.remaining_ms > 0 && timer.remaining_ms <= totalMs
      ? timer.remaining_ms
      : totalMs;
  const endTs = Date.now() + remaining;
  await set("timer", {
    ...timer,
    running: true,
    end_ts: endTs,
    remaining_ms: remaining,
  });
  await schedulePhaseAlarm(endTs);
}

async function pause(): Promise<void> {
  const timer = await get("timer");
  if (!timer.running) return;
  const remaining = Math.max(0, timer.end_ts - Date.now());
  await set("timer", {
    ...timer,
    running: false,
    end_ts: 0,
    remaining_ms: remaining,
  });
  await clearPhaseAlarm();
}

async function reset(): Promise<void> {
  const [timer, settings] = await Promise.all([get("timer"), get("settings")]);
  await set("timer", {
    ...timer,
    running: false,
    end_ts: 0,
    remaining_ms: totalForMode(timer.mode, settings),
  });
  await clearPhaseAlarm();
}

async function skip(): Promise<void> {
  const [timer, settings] = await Promise.all([get("timer"), get("settings")]);
  let sessionCount = timer.session_count;
  // Partial-work credit on skip: count toward stats only when the user has
  // already invested >= MIN_SKIP_FOCUS_MS in the session. recordWorkCompletion
  // itself enforces the floor so we can pass the raw elapsed value here.
  if (timer.mode === "work") {
    const total = totalForMode("work", settings);
    const remaining = timer.running && timer.end_ts > 0
      ? Math.max(0, timer.end_ts - Date.now())
      : Math.max(0, timer.remaining_ms);
    const elapsedMs = Math.max(0, total - remaining);
    await recordWorkSession(elapsedMs, Date.now());
    sessionCount = sessionCount + 1;
  }
  const next = nextMode(timer.mode, sessionCount, settings);
  // session_count counts completed work sessions in the current long-break
  // cycle; reset it the moment a long break starts so the next cycle restarts
  // cleanly.
  if (next === "work" && timer.mode === "long_break") {
    sessionCount = 0;
  }
  await set("timer", {
    mode: next,
    running: false,
    end_ts: 0,
    remaining_ms: totalForMode(next, settings),
    session_count: sessionCount,
  });
  await clearPhaseAlarm();
  // skip() counts as a deliberate phase transition — play the chime for the
  // mode we're moving into (reset() stays silent: design-sound-mute.md).
  await playPhaseTransition(next, settings);
}

async function recordWorkSession(focusMs: number, endTs: number): Promise<void> {
  const stats = await get("stats");
  const recorded = recordWorkCompletion(stats, focusMs, endTs);
  if (recorded === stats) return;
  const pruned = pruneOldDays(recorded, DEFAULT_KEEP_DAYS, endTs);
  await set("stats", pruned);
}

async function handlePhaseEnd(): Promise<void> {
  const [timer, settings] = await Promise.all([get("timer"), get("settings")]);
  if (!timer.running) return;
  let sessionCount = timer.session_count;
  // endTs comes from the stored alarm boundary, not Date.now(), so a delayed
  // service-worker wake doesn't push completion onto the wrong calendar day.
  const endTs = timer.end_ts > 0 ? timer.end_ts : Date.now();
  if (timer.mode === "work") {
    await recordWorkSession(totalForMode("work", settings), endTs);
    sessionCount = sessionCount + 1;
  }
  const next = nextMode(timer.mode, sessionCount, settings);
  if (next === "work" && timer.mode === "long_break") {
    sessionCount = 0;
  }

  const shouldAutoStart =
    (next === "work" && settings.auto_start_work) ||
    ((next === "break" || next === "long_break") && settings.auto_start_break);

  const totalNext = totalForMode(next, settings);
  if (shouldAutoStart) {
    const endTs = Date.now() + totalNext;
    await set("timer", {
      mode: next,
      running: true,
      end_ts: endTs,
      remaining_ms: totalNext,
      session_count: sessionCount,
    });
    await schedulePhaseAlarm(endTs);
  } else {
    await set("timer", {
      mode: next,
      running: false,
      end_ts: 0,
      remaining_ms: totalNext,
      session_count: sessionCount,
    });
    await clearPhaseAlarm();
  }
  await playPhaseTransition(next, settings);
}

async function reconcileAfterWake(): Promise<void> {
  // After service worker wake-up: if running and end_ts already passed (e.g.
  // OS sleep ate the alarm) flush the phase immediately; otherwise re-register
  // the alarm so it survives the new worker lifetime.
  const timer = await get("timer");
  if (!timer.running) return;
  if (timer.end_ts <= Date.now()) {
    await handlePhaseEnd();
  } else {
    await schedulePhaseAlarm(timer.end_ts);
  }
}

async function initialize(): Promise<void> {
  await ensureDefaults();
  await reconcileAfterWake();
}

function isCommand(value: unknown): value is Command {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = (value as { type: unknown }).type;
  return (
    type === "timer_start" ||
    type === "timer_pause" ||
    type === "timer_resume" ||
    type === "timer_reset" ||
    type === "timer_skip"
  );
}

async function dispatch(cmd: Command): Promise<void> {
  switch (cmd.type) {
    case "timer_start":
    case "timer_resume":
      await startOrResume();
      return;
    case "timer_pause":
      await pause();
      return;
    case "timer_reset":
      await reset();
      return;
    case "timer_skip":
      await skip();
      return;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void initialize();
});

chrome.runtime.onStartup.addListener(() => {
  void initialize();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_PHASE_END) {
    void handlePhaseEnd();
  } else if (alarm.name === ALARM_BREAK_REMINDER) {
    // Handled in break-reminder task (T028+); ignore here.
  }
});

// When settings change while the timer is *not* running, refresh remaining_ms
// to the new phase total so the popup shows the updated duration immediately.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("settings" in changes)) return;
  void (async () => {
    const timer = await get("timer");
    if (timer.running) return;
    const settings = (changes.settings.newValue ?? DEFAULT_SETTINGS) as Settings;
    const total = totalForMode(timer.mode, settings);
    if (timer.remaining_ms !== total) {
      await patch("timer", { remaining_ms: total });
    }
  })();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Non-command traffic (e.g. the offscreen document's "sound_play"
  // round-trip) is owned by other listeners — silently opt out so we don't
  // race them on sendResponse.
  if (!isCommand(message)) return false;
  dispatch(message).then(
    () => sendResponse({ ok: true }),
    (err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      sendResponse({ ok: false, error });
    },
  );
  return true; // keep the message channel open for the async response
});

// Service worker wakes are not guaranteed to fire onStartup (e.g. event-driven
// re-activation after being unloaded). Run reconciliation at module top level
// so each wake re-arms the alarm if needed.
void reconcileAfterWake();

export {
  ALARM_PHASE_END,
  ALARM_BREAK_REMINDER,
  totalForMode,
  nextMode,
};
export type { TimerMode, TimerState, Settings };
