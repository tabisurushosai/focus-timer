/**
 * popup.ts — popup entry point.
 * Applies i18n, renders timer state from chrome.storage.local, and wires controls.
 * Concrete timer logic lives in background.ts (later tasks); this file is the view layer.
 */

import { applyI18nToDom, t, type MessageKey } from "./i18n";
import { localDateKey } from "./stats";
import type { Premium, Settings, Stats, TimerMode, TimerState } from "./storage";
import {
  currentRemainingMs,
  formatTime,
  modeKey,
  progressDashOffset,
  totalForMode,
} from "./timer-utils";

const TRIAL_DAYS = 7;
const TRACK_CIRCUMFERENCE = 2 * Math.PI * 92; // matches r=92 in popup.html

const els = {
  body: document.body,
  modeLabel: document.getElementById("mode-label") as HTMLElement,
  timeLeft: document.getElementById("time-left") as HTMLElement,
  progress: document.getElementById("timer-progress") as SVGCircleElement | null,
  sessionCount: document.getElementById("session-count") as HTMLElement,
  focusMinToday: document.getElementById("focus-min-today") as HTMLElement,
  premiumBadge: document.getElementById("premium-badge") as HTMLElement,
  trialBadge: document.getElementById("trial-badge") as HTMLElement,
  btnStart: document.getElementById("btn-start") as HTMLButtonElement,
  btnPause: document.getElementById("btn-pause") as HTMLButtonElement,
  btnResume: document.getElementById("btn-resume") as HTMLButtonElement,
  btnReset: document.getElementById("btn-reset") as HTMLButtonElement,
  btnSkip: document.getElementById("btn-skip") as HTMLButtonElement,
  toggleChildMode: document.getElementById("toggle-child-mode") as HTMLInputElement,
  toggleMute: document.getElementById("toggle-mute") as HTMLInputElement,
  openOptions: document.getElementById("open-options") as HTMLAnchorElement,
  childModeAnnounce: document.getElementById("child-mode-announce") as HTMLElement | null,
  confirmDialog: document.getElementById("confirm-action") as HTMLDialogElement | null,
  confirmTitle: document.getElementById("confirm-title") as HTMLElement | null,
  confirmBody: document.getElementById("confirm-body") as HTMLElement | null,
};

let childModeApplied: boolean | undefined;

let tickHandle: number | undefined;

function applyModeClass(mode: TimerMode): void {
  els.body.classList.remove("mode-work", "mode-break", "mode-long-break");
  els.body.classList.add(
    mode === "break" ? "mode-break" : mode === "long_break" ? "mode-long-break" : "mode-work",
  );
}

function renderTimer(timer: TimerState, settings: Settings): void {
  applyModeClass(timer.mode);
  els.modeLabel.textContent = t(modeKey(timer.mode));

  const remaining = currentRemainingMs(timer);
  els.timeLeft.textContent = formatTime(remaining);

  const total = totalForMode(timer.mode, settings);
  if (els.progress) {
    const offset = progressDashOffset(remaining, total, TRACK_CIRCUMFERENCE);
    els.progress.setAttribute("stroke-dasharray", String(TRACK_CIRCUMFERENCE));
    els.progress.setAttribute("stroke-dashoffset", String(offset));
  }

  const idle = !timer.running && timer.remaining_ms === total;
  els.btnStart.hidden = timer.running || !idle;
  els.btnPause.hidden = !timer.running;
  els.btnResume.hidden = timer.running || idle;
}

function renderStats(stats: Stats): void {
  // localDateKey matches the key background.ts writes — the toISOString slice
  // used UTC and would have flipped buckets at the wrong wall-clock moment.
  const today = localDateKey(Date.now());
  const todayStats = stats.daily?.[today];
  els.sessionCount.textContent = String(todayStats?.sessions ?? 0);
  if (els.focusMinToday) {
    els.focusMinToday.textContent = String(todayStats?.focus_min ?? 0);
  }
}

function renderPremium(premium: Premium): void {
  const now = Date.now();
  const trialElapsedDays = premium.trial_start_ts
    ? (now - premium.trial_start_ts) / 86_400_000
    : Number.POSITIVE_INFINITY;
  const inTrial = !premium.premium_unlocked && trialElapsedDays < TRIAL_DAYS;

  els.premiumBadge.hidden = !premium.premium_unlocked;
  els.premiumBadge.classList.toggle("is-hidden", !premium.premium_unlocked);

  if (inTrial) {
    const daysLeft = Math.max(1, Math.ceil(TRIAL_DAYS - trialElapsedDays));
    els.trialBadge.hidden = false;
    els.trialBadge.classList.remove("is-hidden");
    const label = t("popup_trial_days_left", String(daysLeft));
    els.trialBadge.textContent = label;
  } else {
    els.trialBadge.hidden = true;
    els.trialBadge.classList.add("is-hidden");
  }
}

function applyTheme(settings: Settings): void {
  els.body.classList.remove("theme-system", "theme-light", "theme-dark");
  els.body.classList.add(`theme-${settings.theme}`);
  els.body.classList.toggle("child-mode", settings.child_mode);
  els.toggleChildMode.checked = settings.child_mode;
  els.toggleMute.checked = !settings.sound_enabled;

  if (childModeApplied !== undefined && childModeApplied !== settings.child_mode) {
    announceChildMode(settings.child_mode);
  }
  childModeApplied = settings.child_mode;
}

function announceChildMode(on: boolean): void {
  if (!els.childModeAnnounce) return;
  els.childModeAnnounce.textContent = t(on ? "popup_child_mode_on" : "popup_child_mode_off");
}

async function loadAndRender(): Promise<void> {
  const { settings, timer, stats, premium } = (await chrome.storage.local.get([
    "settings",
    "timer",
    "stats",
    "premium",
  ])) as {
    settings?: Settings;
    timer?: TimerState;
    stats?: Stats;
    premium?: Premium;
  };
  if (!settings || !timer || !stats || !premium) {
    // Storage may not be initialized yet; let background's onInstalled finish.
    return;
  }
  applyTheme(settings);
  renderTimer(timer, settings);
  renderStats(stats);
  renderPremium(premium);
  scheduleTick(timer, settings);
}

function scheduleTick(timer: TimerState, settings: Settings): void {
  if (tickHandle !== undefined) {
    window.clearInterval(tickHandle);
    tickHandle = undefined;
  }
  if (!timer.running) return;
  tickHandle = window.setInterval(() => {
    renderTimer(timer, settings);
    if (currentRemainingMs(timer) <= 0) {
      window.clearInterval(tickHandle);
      tickHandle = undefined;
    }
  }, 250);
}

async function sendCommand(type: string, payload?: Record<string, unknown>): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type, ...(payload ?? {}) });
  } catch {
    // Background may be cold-starting; ignore so the UI stays responsive.
  }
}

async function patchSettings(patch: Partial<Settings>): Promise<void> {
  const { settings } = (await chrome.storage.local.get("settings")) as {
    settings?: Settings;
  };
  if (!settings) return;
  const next = { ...settings, ...patch };
  await chrome.storage.local.set({ settings: next });
}

function isChildMode(): boolean {
  return els.body.classList.contains("child-mode");
}

function confirmAction(titleKey: MessageKey, bodyKey: MessageKey): Promise<boolean> {
  const dialog = els.confirmDialog;
  const titleEl = els.confirmTitle;
  const bodyEl = els.confirmBody;
  if (!dialog || !titleEl || !bodyEl || typeof dialog.showModal !== "function") {
    // No <dialog> support — fall through to immediate execution so child-mode
    // never silently swallows the action.
    return Promise.resolve(true);
  }
  titleEl.textContent = t(titleKey);
  bodyEl.textContent = t(bodyKey);
  return new Promise<boolean>((resolve) => {
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      resolve(dialog.returnValue === "ok");
    };
    dialog.addEventListener("close", onClose);
    dialog.showModal();
  });
}

async function handleReset(): Promise<void> {
  if (isChildMode()) {
    const ok = await confirmAction("popup_confirm_reset_title", "popup_confirm_reset_body");
    if (!ok) return;
  }
  await sendCommand("timer_reset");
}

async function handleSkip(): Promise<void> {
  if (isChildMode()) {
    const ok = await confirmAction("popup_confirm_skip_title", "popup_confirm_skip_body");
    if (!ok) return;
  }
  await sendCommand("timer_skip");
}

function wireControls(): void {
  els.btnStart.addEventListener("click", () => {
    void sendCommand("timer_start");
  });
  els.btnPause.addEventListener("click", () => {
    void sendCommand("timer_pause");
  });
  els.btnResume.addEventListener("click", () => {
    void sendCommand("timer_resume");
  });
  els.btnReset.addEventListener("click", () => {
    void handleReset();
  });
  els.btnSkip.addEventListener("click", () => {
    void handleSkip();
  });

  els.toggleChildMode.addEventListener("change", () => {
    void patchSettings({ child_mode: els.toggleChildMode.checked });
  });
  els.toggleMute.addEventListener("change", () => {
    void patchSettings({ sound_enabled: !els.toggleMute.checked });
  });

  els.openOptions.addEventListener("click", (event) => {
    event.preventDefault();
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL("options.html"));
    }
  });
}

function watchStorage(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      "settings" in changes ||
      "timer" in changes ||
      "stats" in changes ||
      "premium" in changes
    ) {
      void loadAndRender();
    }
  });
}

function bootstrap(): void {
  applyI18nToDom(document);
  wireControls();
  watchStorage();
  void loadAndRender();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
  bootstrap();
}
