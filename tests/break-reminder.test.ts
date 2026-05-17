/**
 * Tests for break-reminder (T030) — contract/integration checks for the design
 * in docs/design-break-reminder.md. The actual desktop notifications and
 * chrome.alarms scheduling cannot fire under Node, so these tests pin the
 * seams that the design depends on:
 *
 *  - notifications.ts pure/contract behaviour:
 *    notifyPhaseTransition / scheduleBreakReminder / clearBreakReminder /
 *    handleBreakReminderAlarm / registerNotificationClickHandler (with a fake
 *    chrome.notifications + chrome.alarms + chrome.i18n)
 *  - i18n keys present in both ja and en locales
 *  - manifest.json carries "notifications" and "alarms" permissions
 *  - storage defaults (notification_enabled / break_reminder_enabled === true)
 *  - background.ts wiring (phase-end / skip fire notification + reminder,
 *    reset stays silent, startOrResume clears the reminder, alarm dispatcher
 *    delegates to handleBreakReminderAlarm, click handler registered)
 *  - options.html exposes the denied hint + reminder hint
 *  - options.ts disables the reminder toggle when the master switch is off
 *    and surfaces the denied hint when chrome permission is "denied"
 *
 * Run with: npm test (uses Node's built-in --test + --experimental-strip-types).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import { DEFAULT_SETTINGS, type Settings } from "../src/storage.ts";
import {
  ALARM_BREAK_REMINDER,
  IDLE_REMINDER_GRACE_MS,
  clearBreakReminder,
  handleBreakReminderAlarm,
  notifyPhaseTransition,
  registerNotificationClickHandler,
  scheduleBreakReminder,
} from "../src/notifications.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function readText(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

function readJson(rel: string): Record<string, { message: string }> {
  return JSON.parse(readText(rel));
}

const BREAK_REMINDER_I18N_KEYS = [
  "popup_break_reminder",
  "popup_break_reminder_body",
  "popup_break_reminder_idle_title",
  "popup_break_reminder_idle_body",
  "popup_session_complete",
  "popup_session_complete_body",
  "options_notification_enabled",
  "options_break_reminder_enabled",
  "options_break_reminder_hint",
  "options_notification_denied_hint",
] as const;

describe("break-reminder: i18n keys", () => {
  const ja = readJson("_locales/ja/messages.json");
  const en = readJson("_locales/en/messages.json");

  for (const key of BREAK_REMINDER_I18N_KEYS) {
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

describe("break-reminder: manifest permissions", () => {
  const manifest = JSON.parse(readText("manifest.json")) as {
    permissions?: string[];
  };

  it("declares the notifications permission", () => {
    assert.ok(Array.isArray(manifest.permissions));
    assert.ok(
      manifest.permissions.includes("notifications"),
      "manifest does not include notifications permission",
    );
  });

  it("declares the alarms permission", () => {
    assert.ok(Array.isArray(manifest.permissions));
    assert.ok(
      manifest.permissions.includes("alarms"),
      "manifest does not include alarms permission",
    );
  });
});

describe("break-reminder: storage defaults", () => {
  it("notification_enabled defaults true (notifications on out of the box)", () => {
    assert.equal(DEFAULT_SETTINGS.notification_enabled, true);
  });
  it("break_reminder_enabled defaults true (idle reminder on out of the box)", () => {
    assert.equal(DEFAULT_SETTINGS.break_reminder_enabled, true);
  });
});

function withSettings(overrides: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

// ---------------------------------------------------------------------------
// notifications.ts contract — uses a fake chrome.{notifications,alarms,i18n}
// to assert the seams the design relies on without firing real notifications.
// ---------------------------------------------------------------------------

type NotifCall = {
  id: string;
  options: chrome.notifications.NotificationOptions<true>;
};
type AlarmCall = { name: string; alarmInfo: chrome.alarms.AlarmCreateInfo };
type ClearCall = { name: string };
type ClickListener = () => void;

type FakeChromeState = {
  notifyCreate: NotifCall[];
  alarmCreate: AlarmCall[];
  alarmClear: ClearCall[];
  clickListeners: ClickListener[];
  openPopupCalls: number;
  permissionLevel: string;
};

function installFakeChrome(overrides?: {
  noNotifications?: boolean;
  noAlarms?: boolean;
  noClickEvent?: boolean;
  noActionOpenPopup?: boolean;
  permissionLevel?: string;
}): FakeChromeState {
  const state: FakeChromeState = {
    notifyCreate: [],
    alarmCreate: [],
    alarmClear: [],
    clickListeners: [],
    openPopupCalls: 0,
    permissionLevel: overrides?.permissionLevel ?? "granted",
  };

  const fakeChrome: Record<string, unknown> = {
    i18n: {
      getMessage: (key: string) => key,
      getUILanguage: () => "en",
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
  };

  if (!overrides?.noNotifications) {
    fakeChrome.notifications = {
      create: (
        id: string,
        options: chrome.notifications.NotificationOptions<true>,
        cb?: (id: string) => void,
      ) => {
        state.notifyCreate.push({ id, options });
        if (cb) cb(id);
      },
      onClicked: overrides?.noClickEvent
        ? undefined
        : {
            addListener: (listener: ClickListener) => {
              state.clickListeners.push(listener);
            },
          },
    };
  }

  if (!overrides?.noAlarms) {
    fakeChrome.alarms = {
      create: async (name: string, alarmInfo: chrome.alarms.AlarmCreateInfo) => {
        state.alarmCreate.push({ name, alarmInfo });
      },
      clear: async (name: string) => {
        state.alarmClear.push({ name });
        return true;
      },
    };
  }

  if (!overrides?.noActionOpenPopup) {
    fakeChrome.action = {
      openPopup: async () => {
        state.openPopupCalls += 1;
      },
    };
  }

  (globalThis as unknown as { chrome: unknown }).chrome = fakeChrome;
  return state;
}

function uninstallFakeChrome(): void {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

// notifications.ts is imported statically at the top — its chrome.* reads
// happen at call time, so installing the fake chrome before each test gives
// the helpers exactly the surface they need without dynamic re-imports
// (which break Node's TS extensionless resolution under cache-busting URLs).

describe("notifications.ts: notifyPhaseTransition", () => {
  afterEach(() => {
    uninstallFakeChrome();
  });

  it("creates a notification with silent:true, priority:0, reused id for break", async () => {
    const state = installFakeChrome();
    await notifyPhaseTransition("break", withSettings({}));
    assert.equal(state.notifyCreate.length, 1);
    const call = state.notifyCreate[0];
    assert.equal(call.id, "focus-timer:transition");
    assert.equal(call.options.type, "basic");
    assert.equal(call.options.silent, true);
    assert.equal(call.options.priority, 0);
    assert.equal(call.options.requireInteraction, false);
    // For break, the title uses popup_break_reminder (fake i18n returns key).
    assert.equal(call.options.title, "popup_break_reminder");
    assert.equal(call.options.message, "popup_break_reminder_body");
  });

  it("uses popup_session_complete copy when transitioning to work", async () => {
    const state = installFakeChrome();
    await notifyPhaseTransition("work", withSettings({}));
    assert.equal(state.notifyCreate.length, 1);
    assert.equal(state.notifyCreate[0].options.title, "popup_session_complete");
    assert.equal(state.notifyCreate[0].options.message, "popup_session_complete_body");
  });

  it("uses popup_break_reminder copy for long_break (shared with break)", async () => {
    const state = installFakeChrome();
    await notifyPhaseTransition("long_break", withSettings({}));
    assert.equal(state.notifyCreate.length, 1);
    assert.equal(state.notifyCreate[0].options.title, "popup_break_reminder");
  });

  it("reuses the same notification_id across calls (no stacking)", async () => {
    const state = installFakeChrome();
    await notifyPhaseTransition("work", withSettings({}));
    await notifyPhaseTransition("break", withSettings({}));
    assert.equal(state.notifyCreate.length, 2);
    assert.equal(state.notifyCreate[0].id, "focus-timer:transition");
    assert.equal(state.notifyCreate[1].id, "focus-timer:transition");
  });

  it("no-ops when notification_enabled === false (no create call)", async () => {
    const state = installFakeChrome();
    await notifyPhaseTransition(
      "break",
      withSettings({ notification_enabled: false }),
    );
    assert.equal(state.notifyCreate.length, 0);
  });

  it("no-ops gracefully when chrome.notifications is absent", async () => {
    installFakeChrome({ noNotifications: true });
    await notifyPhaseTransition("work", withSettings({}));
    // No throw is the contract.
    assert.ok(true);
  });
});

describe("notifications.ts: scheduleBreakReminder", () => {
  afterEach(() => {
    uninstallFakeChrome();
  });

  it("clears any prior alarm before scheduling (idempotent re-entry)", async () => {
    const state = installFakeChrome();
    await scheduleBreakReminder(withSettings({}), "break", 0);
    assert.ok(
      state.alarmClear.some((c) => c.name === ALARM_BREAK_REMINDER),
      "scheduleBreakReminder must clear before creating",
    );
  });

  it("does NOT create an alarm when next phase is work (only clears)", async () => {
    const state = installFakeChrome();
    await scheduleBreakReminder(withSettings({}), "work", 0);
    assert.equal(state.alarmCreate.length, 0);
  });

  it("does NOT create an alarm when notification_enabled === false", async () => {
    const state = installFakeChrome();
    await scheduleBreakReminder(
      withSettings({ notification_enabled: false }),
      "break",
      0,
    );
    assert.equal(state.alarmCreate.length, 0);
  });

  it("does NOT create an alarm when break_reminder_enabled === false", async () => {
    const state = installFakeChrome();
    await scheduleBreakReminder(
      withSettings({ break_reminder_enabled: false }),
      "break",
      0,
    );
    assert.equal(state.alarmCreate.length, 0);
  });

  it("does NOT create an alarm when auto_start_work === true (user not idle)", async () => {
    const state = installFakeChrome();
    await scheduleBreakReminder(
      withSettings({ auto_start_work: true }),
      "break",
      0,
    );
    assert.equal(state.alarmCreate.length, 0);
  });

  it("schedules at breakStartTs + break_min*60s + 5min grace for break", async () => {
    const state = installFakeChrome();
    const startTs = 1_000_000;
    const settings = withSettings({ break_min: 5 });
    await scheduleBreakReminder(settings, "break", startTs);
    assert.equal(state.alarmCreate.length, 1);
    assert.equal(state.alarmCreate[0].name, ALARM_BREAK_REMINDER);
    const expected = startTs + 5 * 60_000 + IDLE_REMINDER_GRACE_MS;
    assert.equal(state.alarmCreate[0].alarmInfo.when, expected);
  });

  it("schedules using long_break_min for long_break", async () => {
    const state = installFakeChrome();
    const startTs = 2_000_000;
    await scheduleBreakReminder(
      withSettings({ long_break_min: 15 }),
      "long_break",
      startTs,
    );
    assert.equal(state.alarmCreate.length, 1);
    const expected = startTs + 15 * 60_000 + IDLE_REMINDER_GRACE_MS;
    assert.equal(state.alarmCreate[0].alarmInfo.when, expected);
  });

  it("no-ops gracefully when chrome.alarms is absent", async () => {
    installFakeChrome({ noAlarms: true });
    await scheduleBreakReminder(withSettings({}), "break", 0);
    assert.ok(true, "absence of chrome.alarms must not throw");
  });
});

describe("notifications.ts: clearBreakReminder", () => {
  afterEach(() => {
    uninstallFakeChrome();
  });

  it("calls chrome.alarms.clear with the canonical name", async () => {
    const state = installFakeChrome();
    await clearBreakReminder();
    assert.ok(state.alarmClear.some((c) => c.name === ALARM_BREAK_REMINDER));
  });

  it("is idempotent — safe to call when no alarm exists", async () => {
    installFakeChrome();
    await clearBreakReminder();
    await clearBreakReminder();
    assert.ok(true);
  });

  it("no-ops when chrome.alarms is absent", async () => {
    installFakeChrome({ noAlarms: true });
    await clearBreakReminder();
    assert.ok(true);
  });
});

describe("notifications.ts: handleBreakReminderAlarm", () => {
  afterEach(() => {
    uninstallFakeChrome();
  });

  it("does nothing when notification_enabled === false", async () => {
    const state = installFakeChrome();
    await handleBreakReminderAlarm(
      withSettings({ notification_enabled: false }),
      "break",
      false,
    );
    assert.equal(state.notifyCreate.length, 0);
  });

  it("does nothing when break_reminder_enabled === false", async () => {
    const state = installFakeChrome();
    await handleBreakReminderAlarm(
      withSettings({ break_reminder_enabled: false }),
      "break",
      false,
    );
    assert.equal(state.notifyCreate.length, 0);
  });

  it("does nothing when the timer is already running", async () => {
    const state = installFakeChrome();
    await handleBreakReminderAlarm(withSettings({}), "break", true);
    assert.equal(state.notifyCreate.length, 0);
  });

  it("does nothing when the current phase is work", async () => {
    const state = installFakeChrome();
    await handleBreakReminderAlarm(withSettings({}), "work", false);
    assert.equal(state.notifyCreate.length, 0);
  });

  it("creates the idle-reminder notification (separate id) when conditions match", async () => {
    const state = installFakeChrome();
    await handleBreakReminderAlarm(withSettings({}), "break", false);
    assert.equal(state.notifyCreate.length, 1);
    assert.equal(state.notifyCreate[0].id, "focus-timer:idle-reminder");
    assert.equal(state.notifyCreate[0].options.silent, true);
    assert.equal(state.notifyCreate[0].options.title, "popup_break_reminder_idle_title");
    assert.equal(state.notifyCreate[0].options.message, "popup_break_reminder_idle_body");
  });

  it("fires for long_break too", async () => {
    const state = installFakeChrome();
    await handleBreakReminderAlarm(withSettings({}), "long_break", false);
    assert.equal(state.notifyCreate.length, 1);
  });
});

describe("notifications.ts: registerNotificationClickHandler", () => {
  afterEach(() => {
    uninstallFakeChrome();
  });

  it("subscribes to chrome.notifications.onClicked and opens the popup", async () => {
    const state = installFakeChrome();
    registerNotificationClickHandler();
    assert.equal(state.clickListeners.length, 1);
    // Simulate a click — should try chrome.action.openPopup() once.
    state.clickListeners[0]();
    // openPopup is async on the fake; allow the microtask to settle.
    await Promise.resolve();
    assert.equal(state.openPopupCalls, 1);
  });

  it("no-ops when chrome.notifications.onClicked is unavailable", async () => {
    installFakeChrome({ noClickEvent: true });
    // Must not throw.
    registerNotificationClickHandler();
    assert.ok(true);
  });

  it("no-ops when chrome.action.openPopup is unavailable on click", async () => {
    const state = installFakeChrome({ noActionOpenPopup: true });
    registerNotificationClickHandler();
    assert.equal(state.clickListeners.length, 1);
    // Click should not throw even though openPopup is missing.
    state.clickListeners[0]();
    assert.equal(state.openPopupCalls, 0);
  });
});

describe("break-reminder: background wiring", () => {
  const src = readText("src/background.ts");

  it("imports the four notifications helpers + ALARM_BREAK_REMINDER", () => {
    assert.match(src, /from\s+"\.\/notifications"/);
    assert.match(src, /notifyPhaseTransition/);
    assert.match(src, /scheduleBreakReminder/);
    assert.match(src, /clearBreakReminder/);
    assert.match(src, /handleBreakReminderAlarm/);
    assert.match(src, /ALARM_BREAK_REMINDER/);
    assert.match(src, /registerNotificationClickHandler/);
  });

  it("handlePhaseEnd calls notifyPhaseTransition AND scheduleBreakReminder", () => {
    const block = /async function handlePhaseEnd\([\s\S]*?\n\}\n/.exec(src)?.[0] ?? "";
    assert.ok(block.length > 0, "handlePhaseEnd block not found");
    assert.match(block, /notifyPhaseTransition\(\s*next\s*,\s*settings\s*\)/);
    assert.match(block, /scheduleBreakReminder\(\s*settings\s*,\s*next\s*,/);
  });

  it("skip() calls notifyPhaseTransition AND scheduleBreakReminder", () => {
    const block = /async function skip\([\s\S]*?\n\}\n/.exec(src)?.[0] ?? "";
    assert.ok(block.length > 0, "skip block not found");
    assert.match(block, /notifyPhaseTransition\(\s*next\s*,\s*settings\s*\)/);
    assert.match(block, /scheduleBreakReminder\(\s*settings\s*,\s*next\s*,/);
  });

  it("reset() clears the reminder and does NOT fire a notification", () => {
    // reset() being silent is in the design's acceptance criteria. Pin it so a
    // future refactor doesn't accidentally nag the user.
    const block = /async function reset\([\s\S]*?\n\}\n/.exec(src)?.[0] ?? "";
    assert.ok(block.length > 0, "reset block not found");
    assert.match(block, /clearBreakReminder\(\)/);
    assert.doesNotMatch(block, /notifyPhaseTransition/);
    assert.doesNotMatch(block, /scheduleBreakReminder/);
  });

  it("startOrResume clears the reminder (user is engaged again)", () => {
    const block = /async function startOrResume\([\s\S]*?\n\}\n/.exec(src)?.[0] ?? "";
    assert.ok(block.length > 0, "startOrResume block not found");
    assert.match(block, /clearBreakReminder\(\)/);
  });

  it("chrome.alarms.onAlarm dispatches ALARM_BREAK_REMINDER to handleBreakReminderAlarm", () => {
    assert.match(
      src,
      /alarm\.name\s*===\s*ALARM_BREAK_REMINDER[\s\S]*?handleBreakReminderAlarm\(/,
    );
  });

  it("registerNotificationClickHandler is invoked at module top level", () => {
    // Must be called once on each service worker wake, not lazily, so the
    // listener is alive before any click can arrive.
    assert.match(src, /\nregisterNotificationClickHandler\(\);/);
  });
});

describe("break-reminder: options HTML surface", () => {
  const html = readText("src/options.html");

  it("exposes #opt-notification-enabled (master switch)", () => {
    assert.match(html, /id="opt-notification-enabled"/);
  });

  it("exposes #opt-break-reminder-enabled (dependent toggle)", () => {
    assert.match(html, /id="opt-break-reminder-enabled"/);
  });

  it("exposes #opt-break-reminder-hint with the explanation i18n key", () => {
    assert.match(html, /id="opt-break-reminder-hint"/);
    assert.match(html, /data-i18n="options_break_reminder_hint"/);
  });

  it("exposes #opt-notification-denied-hint as a role=status, hidden by default", () => {
    assert.match(html, /id="opt-notification-denied-hint"/);
    assert.match(html, /data-i18n="options_notification_denied_hint"/);
    // The hint must be role=status (announced politely) and hidden until the
    // permission check flips it on.
    assert.match(
      html,
      /id="opt-notification-denied-hint"[\s\S]*?role="status"[\s\S]*?hidden|id="opt-notification-denied-hint"[\s\S]*?hidden[\s\S]*?role="status"/,
    );
  });
});

describe("break-reminder: options.ts wiring", () => {
  const src = readText("src/options.ts");

  it("applyNotificationUiState disables break-reminder toggle when master off", () => {
    const block = /function applyNotificationUiState\([\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    assert.ok(block.length > 0, "applyNotificationUiState block not found");
    assert.match(block, /els\.breakReminderEnabled\.disabled\s*=/);
    assert.match(block, /is-disabled/);
  });

  it("checkNotificationPermission reads chrome.notifications.getPermissionLevel", () => {
    const block = /function checkNotificationPermission\([\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    assert.ok(block.length > 0, "checkNotificationPermission block not found");
    assert.match(block, /getPermissionLevel/);
    assert.match(block, /denied/);
  });

  it("wires the notification toggle change to applyNotificationUiState + permission check", () => {
    assert.match(
      src,
      /els\.notificationEnabled\.addEventListener\("change"[\s\S]*?applyNotificationUiState[\s\S]*?checkNotificationPermission/,
    );
  });

  it("renderForm applies the notification UI state on every render", () => {
    const block = /function renderForm\([\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    assert.ok(block.length > 0, "renderForm block not found");
    assert.match(block, /applyNotificationUiState\(/);
    assert.match(block, /checkNotificationPermission\(/);
  });
});
