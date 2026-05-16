/**
 * options.ts — options page entry point.
 * Loads settings/premium from chrome.storage.local, renders the form,
 * and persists changes back. Form is the source of truth on submit.
 */

import { applyI18nToDom, t } from "./i18n";

type Theme = "light" | "dark" | "system";
type Language = "ja" | "en" | "auto";

type Settings = {
  work_min: number;
  break_min: number;
  long_break_min: number;
  sessions_until_long_break: number;
  auto_start_break: boolean;
  auto_start_work: boolean;
  theme: Theme;
  sound_enabled: boolean;
  sound_volume: number;
  notification_enabled: boolean;
  break_reminder_enabled: boolean;
  child_mode: boolean;
  language: Language;
};

type Premium = {
  trial_start_ts: number;
  premium_unlocked: boolean;
};

const TRIAL_DAYS = 7;
const SAVED_INDICATOR_MS = 1800;

// Mirrors DEFAULT_SETTINGS in background.ts; kept local to avoid pulling the
// service-worker module into the options bundle.
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

const els = {
  body: document.body,
  form: document.getElementById("options-form") as HTMLFormElement,
  workMin: document.getElementById("opt-work-min") as HTMLInputElement,
  breakMin: document.getElementById("opt-break-min") as HTMLInputElement,
  longBreakMin: document.getElementById("opt-long-break-min") as HTMLInputElement,
  sessionsUntilLong: document.getElementById("opt-sessions-until-long") as HTMLInputElement,
  autoStartBreak: document.getElementById("opt-auto-start-break") as HTMLInputElement,
  autoStartWork: document.getElementById("opt-auto-start-work") as HTMLInputElement,
  childMode: document.getElementById("opt-child-mode") as HTMLInputElement,
  language: document.getElementById("opt-language") as HTMLSelectElement,
  soundEnabled: document.getElementById("opt-sound-enabled") as HTMLInputElement,
  soundVolume: document.getElementById("opt-sound-volume") as HTMLInputElement,
  soundVolumeOut: document.getElementById("opt-sound-volume-out") as HTMLOutputElement,
  notificationEnabled: document.getElementById("opt-notification-enabled") as HTMLInputElement,
  breakReminderEnabled: document.getElementById("opt-break-reminder-enabled") as HTMLInputElement,
  themeRadios: Array.from(
    document.querySelectorAll<HTMLInputElement>('input[name="theme"]'),
  ),
  premiumStatus: document.getElementById("premium-status") as HTMLElement,
  btnUpgrade: document.getElementById("btn-upgrade") as HTMLButtonElement,
  btnReset: document.getElementById("btn-reset") as HTMLButtonElement,
  savedIndicator: document.getElementById("saved-indicator") as HTMLElement,
};

let savedIndicatorTimeout: number | undefined;

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.sound_volume;
  return Math.min(1, Math.max(0, value));
}

function isTheme(value: string): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function isLanguage(value: string): value is Language {
  return value === "ja" || value === "en" || value === "auto";
}

function renderTheme(theme: Theme): void {
  els.body.classList.remove("theme-system", "theme-light", "theme-dark");
  els.body.classList.add(`theme-${theme}`);
}

function renderForm(settings: Settings): void {
  els.workMin.value = String(settings.work_min);
  els.breakMin.value = String(settings.break_min);
  els.longBreakMin.value = String(settings.long_break_min);
  els.sessionsUntilLong.value = String(settings.sessions_until_long_break);
  els.autoStartBreak.checked = settings.auto_start_break;
  els.autoStartWork.checked = settings.auto_start_work;
  els.childMode.checked = settings.child_mode;
  els.language.value = settings.language;
  els.soundEnabled.checked = settings.sound_enabled;
  els.soundVolume.value = String(settings.sound_volume);
  els.soundVolumeOut.value = `${Math.round(settings.sound_volume * 100)}%`;
  els.notificationEnabled.checked = settings.notification_enabled;
  els.breakReminderEnabled.checked = settings.break_reminder_enabled;
  for (const radio of els.themeRadios) {
    radio.checked = radio.value === settings.theme;
  }
  renderTheme(settings.theme);
  els.body.classList.toggle("child-mode", settings.child_mode);
}

function readForm(): Settings {
  const themeRadio = els.themeRadios.find((r) => r.checked);
  const themeValue = themeRadio?.value ?? DEFAULT_SETTINGS.theme;
  const langValue = els.language.value;

  return {
    work_min: clampNumber(Number(els.workMin.value), 1, 180, DEFAULT_SETTINGS.work_min),
    break_min: clampNumber(Number(els.breakMin.value), 1, 60, DEFAULT_SETTINGS.break_min),
    long_break_min: clampNumber(
      Number(els.longBreakMin.value),
      1,
      120,
      DEFAULT_SETTINGS.long_break_min,
    ),
    sessions_until_long_break: clampNumber(
      Number(els.sessionsUntilLong.value),
      1,
      12,
      DEFAULT_SETTINGS.sessions_until_long_break,
    ),
    auto_start_break: els.autoStartBreak.checked,
    auto_start_work: els.autoStartWork.checked,
    theme: isTheme(themeValue) ? themeValue : DEFAULT_SETTINGS.theme,
    sound_enabled: els.soundEnabled.checked,
    sound_volume: clampVolume(Number(els.soundVolume.value)),
    notification_enabled: els.notificationEnabled.checked,
    break_reminder_enabled: els.breakReminderEnabled.checked,
    child_mode: els.childMode.checked,
    language: isLanguage(langValue) ? langValue : DEFAULT_SETTINGS.language,
  };
}

function renderPremium(premium: Premium): void {
  const now = Date.now();
  const trialElapsedDays = premium.trial_start_ts
    ? (now - premium.trial_start_ts) / 86_400_000
    : Number.POSITIVE_INFINITY;
  const inTrial = !premium.premium_unlocked && trialElapsedDays < TRIAL_DAYS;

  let key: "options_premium_status_unlocked" | "options_premium_status_trial" | "options_premium_status_free";
  if (premium.premium_unlocked) {
    key = "options_premium_status_unlocked";
  } else if (inTrial) {
    key = "options_premium_status_trial";
  } else {
    key = "options_premium_status_free";
  }
  els.premiumStatus.textContent = t(key);
  els.premiumStatus.dataset.i18n = key;
  els.btnUpgrade.disabled = premium.premium_unlocked;
}

function flashSaved(): void {
  els.savedIndicator.hidden = false;
  els.savedIndicator.classList.remove("is-hidden");
  if (savedIndicatorTimeout !== undefined) {
    window.clearTimeout(savedIndicatorTimeout);
  }
  savedIndicatorTimeout = window.setTimeout(() => {
    els.savedIndicator.hidden = true;
    els.savedIndicator.classList.add("is-hidden");
  }, SAVED_INDICATOR_MS);
}

async function loadAndRender(): Promise<void> {
  const { settings, premium } = (await chrome.storage.local.get([
    "settings",
    "premium",
  ])) as { settings?: Settings; premium?: Premium };

  renderForm({ ...DEFAULT_SETTINGS, ...(settings ?? {}) });
  renderPremium(
    premium ?? { trial_start_ts: Date.now(), premium_unlocked: false },
  );
}

async function saveSettings(): Promise<void> {
  const next = readForm();
  await chrome.storage.local.set({ settings: next });
  renderTheme(next.theme);
  els.body.classList.toggle("child-mode", next.child_mode);
  flashSaved();
}

async function resetToDefaults(): Promise<void> {
  renderForm(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  flashSaved();
}

function wireForm(): void {
  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveSettings();
  });

  els.btnReset.addEventListener("click", () => {
    void resetToDefaults();
  });

  // Live preview for theme/child-mode toggles so the user sees feedback
  // immediately — the persisted value still requires Save.
  for (const radio of els.themeRadios) {
    radio.addEventListener("change", () => {
      const value = radio.value;
      if (isTheme(value)) renderTheme(value);
    });
  }
  els.childMode.addEventListener("change", () => {
    els.body.classList.toggle("child-mode", els.childMode.checked);
  });

  els.soundVolume.addEventListener("input", () => {
    const pct = Math.round(Number(els.soundVolume.value) * 100);
    els.soundVolumeOut.value = `${pct}%`;
  });

  els.btnUpgrade.addEventListener("click", () => {
    // Stripe Checkout wiring lands in T033. Surface a benign placeholder so
    // the button is interactive without making external requests.
    els.btnUpgrade.disabled = true;
    window.setTimeout(() => {
      els.btnUpgrade.disabled = false;
    }, 600);
  });
}

function watchStorage(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("premium" in changes || "settings" in changes) {
      void loadAndRender();
    }
  });
}

function bootstrap(): void {
  applyI18nToDom(document);
  wireForm();
  watchStorage();
  void loadAndRender();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
  bootstrap();
}
