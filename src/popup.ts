/**
 * popup.ts — popup entry point.
 * Applies i18n, renders timer state from chrome.storage.local, and wires controls.
 * Concrete timer logic lives in background.ts (later tasks); this file is the view layer.
 */

import { applyI18nToDom, t } from "./i18n";

type TimerMode = "work" | "break" | "long_break";

type TimerState = {
  mode: TimerMode;
  running: boolean;
  end_ts: number;
  remaining_ms: number;
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
  daily: Record<string, { focus_min: number; sessions: number }>;
  total_focus_min: number;
  total_sessions: number;
};

type Premium = {
  trial_start_ts: number;
  premium_unlocked: boolean;
};

const TRIAL_DAYS = 7;
const TRACK_CIRCUMFERENCE = 2 * Math.PI * 92; // matches r=92 in popup.html

const els = {
  body: document.body,
  modeLabel: document.getElementById("mode-label") as HTMLElement,
  timeLeft: document.getElementById("time-left") as HTMLElement,
  progress: document.getElementById("timer-progress") as SVGCircleElement | null,
  sessionCount: document.getElementById("session-count") as HTMLElement,
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
};

let tickHandle: number | undefined;

function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function modeKey(mode: TimerMode): "popup_mode_work" | "popup_mode_break" | "popup_mode_long_break" {
  if (mode === "break") return "popup_mode_break";
  if (mode === "long_break") return "popup_mode_long_break";
  return "popup_mode_work";
}

function totalForMode(mode: TimerMode, settings: Settings): number {
  const minutes =
    mode === "break"
      ? settings.break_min
      : mode === "long_break"
        ? settings.long_break_min
        : settings.work_min;
  return Math.max(1, minutes) * 60_000;
}

function currentRemainingMs(timer: TimerState): number {
  if (timer.running && timer.end_ts > 0) {
    return Math.max(0, timer.end_ts - Date.now());
  }
  return Math.max(0, timer.remaining_ms);
}

function renderTimer(timer: TimerState, settings: Settings): void {
  els.modeLabel.textContent = t(modeKey(timer.mode));

  const remaining = currentRemainingMs(timer);
  els.timeLeft.textContent = formatTime(remaining);

  const total = totalForMode(timer.mode, settings);
  if (els.progress) {
    const ratio = total > 0 ? remaining / total : 0;
    const offset = TRACK_CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, ratio)));
    els.progress.setAttribute("stroke-dasharray", String(TRACK_CIRCUMFERENCE));
    els.progress.setAttribute("stroke-dashoffset", String(offset));
  }

  const idle = !timer.running && timer.remaining_ms === total;
  els.btnStart.hidden = timer.running || !idle;
  els.btnPause.hidden = !timer.running;
  els.btnResume.hidden = timer.running || idle;
}

function renderStats(stats: Stats): void {
  const today = new Date().toISOString().slice(0, 10);
  const todayStats = stats.daily?.[today];
  els.sessionCount.textContent = String(todayStats?.sessions ?? 0);
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
    void sendCommand("timer_reset");
  });
  els.btnSkip.addEventListener("click", () => {
    void sendCommand("timer_skip");
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
