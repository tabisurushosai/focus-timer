/**
 * background.ts — Manifest V3 service_worker entry point.
 * Keep handlers short; the service worker is unloaded when idle.
 */

const ALARM_TICK = "focus-timer:tick";
const ALARM_BREAK_REMINDER = "focus-timer:break-reminder";

type TimerMode = "work" | "break" | "long_break";

type TimerState = {
  mode: TimerMode;
  running: boolean;
  // Epoch ms when the current phase should end. 0 when not running.
  end_ts: number;
  // Remaining ms captured at pause; used to resume without drift.
  remaining_ms: number;
  // Number of completed work sessions since the last long break.
  session_count: number;
};

type Settings = {
  work_min: number;
  break_min: number;
  long_break_min: number;
  sessions_until_long_break: number;
  auto_start_break: boolean;
  auto_start_work: boolean;
  theme: "light" | "dark" | "system";
  sound_enabled: boolean;
  sound_volume: number;
  notification_enabled: boolean;
  break_reminder_enabled: boolean;
  child_mode: boolean;
  language: "ja" | "en" | "auto";
};

type Stats = {
  // Map of YYYY-MM-DD → { focus_min, sessions }.
  daily: Record<string, { focus_min: number; sessions: number }>;
  total_focus_min: number;
  total_sessions: number;
};

type Premium = {
  trial_start_ts: number;
  premium_unlocked: boolean;
};

const DEFAULT_SETTINGS: Settings = {
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

const DEFAULT_TIMER: TimerState = {
  mode: "work",
  running: false,
  end_ts: 0,
  remaining_ms: DEFAULT_SETTINGS.work_min * 60_000,
  session_count: 0,
};

const DEFAULT_STATS: Stats = {
  daily: {},
  total_focus_min: 0,
  total_sessions: 0,
};

async function initializeStorage(): Promise<void> {
  const existing = await chrome.storage.local.get([
    "settings",
    "timer",
    "stats",
    "premium",
  ]);

  const patch: Record<string, unknown> = {};
  if (!existing.settings) patch.settings = DEFAULT_SETTINGS;
  if (!existing.timer) patch.timer = DEFAULT_TIMER;
  if (!existing.stats) patch.stats = DEFAULT_STATS;
  if (!existing.premium) {
    const premium: Premium = {
      trial_start_ts: Date.now(),
      premium_unlocked: false,
    };
    patch.premium = premium;
  }
  if (Object.keys(patch).length > 0) {
    await chrome.storage.local.set(patch);
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await initializeStorage();
  if (details.reason === "install") {
    // First install — nothing else to do here yet; popup handles onboarding.
  }
});

chrome.runtime.onStartup.addListener(async () => {
  // Ensure defaults exist even if storage was cleared between sessions.
  await initializeStorage();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_TICK) {
    // Phase completion is handled here in a later task; skeleton no-op.
  } else if (alarm.name === ALARM_BREAK_REMINDER) {
    // Break reminder fires here in a later task.
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Command surface for popup/options. Concrete handlers land in later tasks.
  if (!message || typeof message !== "object" || !("type" in message)) {
    sendResponse({ ok: false, error: "invalid_message" });
    return false;
  }
  sendResponse({ ok: true });
  return false;
});

export type { TimerMode, TimerState, Settings, Stats, Premium };
export {
  ALARM_TICK,
  ALARM_BREAK_REMINDER,
  DEFAULT_SETTINGS,
  DEFAULT_TIMER,
  DEFAULT_STATS,
};
