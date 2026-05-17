/**
 * notifications.ts — single window for chrome.notifications and the
 * idle-break-reminder alarm.
 *
 * The service worker calls these helpers from handlePhaseEnd / skip /
 * startOrResume / reset; they own the notification_enabled and
 * break_reminder_enabled checks so background.ts never has to repeat the
 * predicate. All chrome.* calls are guarded so the module is a no-op on
 * Chromes without notifications/alarms (and inside unit tests).
 *
 * Design: docs/design-break-reminder.md.
 */

import { t } from "./i18n";
import type { Settings } from "./storage";

export const ALARM_BREAK_REMINDER = "focus-timer:break-reminder";
const NOTIFICATION_ID_TRANSITION = "focus-timer:transition";
const NOTIFICATION_ID_IDLE = "focus-timer:idle-reminder";

/** Extra grace beyond the configured break duration before nudging. */
export const IDLE_REMINDER_GRACE_MS = 5 * 60_000;

export type TransitionTone = "work" | "break" | "long_break";

type NotificationsApi = {
  create: (
    id: string,
    options: chrome.notifications.NotificationOptions<true>,
    callback?: (id: string) => void,
  ) => void;
  onClicked?: chrome.notifications.NotificationClickedEvent;
};

type AlarmsApi = {
  create: (name: string, alarmInfo: chrome.alarms.AlarmCreateInfo) => void | Promise<void>;
  clear: (name: string, callback?: (wasCleared: boolean) => void) => void | Promise<boolean>;
};

function getNotificationsApi(): NotificationsApi | null {
  const api = (chrome as unknown as { notifications?: NotificationsApi }).notifications;
  if (!api || typeof api.create !== "function") return null;
  return api;
}

function getAlarmsApi(): AlarmsApi | null {
  const api = (chrome as unknown as { alarms?: AlarmsApi }).alarms;
  if (!api || typeof api.create !== "function" || typeof api.clear !== "function") return null;
  return api;
}

function getIconUrl(): string {
  const runtime = (chrome as unknown as {
    runtime?: { getURL?: (path: string) => string };
  }).runtime;
  if (runtime && typeof runtime.getURL === "function") {
    return runtime.getURL("icons/icon128.png");
  }
  return "icons/icon128.png";
}

function titleAndBodyFor(
  to: TransitionTone,
): { title: string; message: string } {
  if (to === "work") {
    return {
      title: t("popup_session_complete"),
      message: t("popup_session_complete_body"),
    };
  }
  return {
    title: t("popup_break_reminder"),
    message: t("popup_break_reminder_body"),
  };
}

/**
 * Show the phase-transition notification. Reuses one notification_id so the
 * OS replaces any previous transition card instead of stacking them. Never
 * throws: notification failures are logged and swallowed.
 */
export async function notifyPhaseTransition(
  to: TransitionTone,
  settings: Settings,
): Promise<void> {
  if (!settings.notification_enabled) return;
  const api = getNotificationsApi();
  if (!api) return;
  const { title, message } = titleAndBodyFor(to);
  try {
    await new Promise<void>((resolve) => {
      api.create(
        NOTIFICATION_ID_TRANSITION,
        {
          type: "basic",
          iconUrl: getIconUrl(),
          title,
          message,
          priority: 0,
          // OS chime is suppressed; sound.ts owns the audible cue so the two
          // never double up (design-break-reminder.md / design-sound-mute.md).
          silent: true,
          requireInteraction: false,
        },
        () => resolve(),
      );
    });
  } catch (err) {
    console.warn("notifyPhaseTransition failed", err);
  }
}

/**
 * Schedule the idle-break reminder alarm. Only fires for break / long_break
 * phases that the user has not auto-started — auto-start implies the user
 * does not need nudging back. Always clears any prior alarm first so a
 * stale reminder from a previous phase cannot fire into a new one.
 */
export async function scheduleBreakReminder(
  settings: Settings,
  to: TransitionTone,
  breakStartTs: number,
): Promise<void> {
  await clearBreakReminder();
  if (to === "work") return;
  if (!settings.notification_enabled) return;
  if (!settings.break_reminder_enabled) return;
  if (settings.auto_start_work) return;
  const api = getAlarmsApi();
  if (!api) return;
  const breakMinutes = to === "long_break" ? settings.long_break_min : settings.break_min;
  const when = breakStartTs + Math.max(1, breakMinutes) * 60_000 + IDLE_REMINDER_GRACE_MS;
  try {
    await api.create(ALARM_BREAK_REMINDER, { when });
  } catch (err) {
    console.warn("scheduleBreakReminder failed", err);
  }
}

/** Idempotent. Safe to call even when no alarm has been scheduled. */
export async function clearBreakReminder(): Promise<void> {
  const api = getAlarmsApi();
  if (!api) return;
  try {
    await api.clear(ALARM_BREAK_REMINDER);
  } catch (err) {
    console.warn("clearBreakReminder failed", err);
  }
}

/**
 * Invoked from chrome.alarms.onAlarm when ALARM_BREAK_REMINDER fires. Checks
 * the current timer/settings state again to avoid racing a phase change that
 * happened between scheduling and firing.
 */
export async function handleBreakReminderAlarm(
  settings: Settings,
  timerMode: TransitionTone,
  timerRunning: boolean,
): Promise<void> {
  if (!settings.notification_enabled) return;
  if (!settings.break_reminder_enabled) return;
  if (timerRunning) return;
  if (timerMode !== "break" && timerMode !== "long_break") return;
  const api = getNotificationsApi();
  if (!api) return;
  try {
    await new Promise<void>((resolve) => {
      api.create(
        NOTIFICATION_ID_IDLE,
        {
          type: "basic",
          iconUrl: getIconUrl(),
          title: t("popup_break_reminder_idle_title"),
          message: t("popup_break_reminder_idle_body"),
          priority: 0,
          silent: true,
          requireInteraction: false,
        },
        () => resolve(),
      );
    });
  } catch (err) {
    console.warn("handleBreakReminderAlarm failed", err);
  }
}

/**
 * Hook up chrome.notifications.onClicked once per service-worker lifetime.
 * On click we try to open the action popup; failure (Chrome's restriction on
 * non-user-gesture opens) is logged but otherwise silent.
 */
export function registerNotificationClickHandler(): void {
  const api = getNotificationsApi();
  if (!api || !api.onClicked || typeof api.onClicked.addListener !== "function") return;
  api.onClicked.addListener(() => {
    const action = (chrome as unknown as {
      action?: { openPopup?: () => Promise<void> | void };
    }).action;
    if (!action || typeof action.openPopup !== "function") return;
    try {
      const result = action.openPopup();
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err) => {
          console.warn("openPopup rejected", err);
        });
      }
    } catch (err) {
      console.warn("openPopup threw", err);
    }
  });
}
