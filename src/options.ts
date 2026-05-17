/**
 * options.ts — options page entry point.
 * Loads settings/premium from chrome.storage.local, renders the form,
 * and persists changes back. Form is the source of truth on submit.
 */

import { applyI18nToDom, t, type MessageKey } from "./i18n";
import {
  hasPremiumAccess,
  isPremium,
  isTrial,
  trialDaysLeft,
} from "./premium";
import { lastNDays } from "./stats";
import { DEFAULT_STATS, type Stats } from "./storage";
import { clampVolumeForMode, playPhaseTransition } from "./sound";
import { applyLicenseKey, openCheckout } from "./upgrade";

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
  soundVolumeChildHint: document.getElementById("opt-sound-volume-child-hint") as HTMLElement | null,
  btnSoundTest: document.getElementById("btn-sound-test") as HTMLButtonElement | null,
  notificationEnabled: document.getElementById("opt-notification-enabled") as HTMLInputElement,
  notificationDeniedHint: document.getElementById("opt-notification-denied-hint") as HTMLElement | null,
  breakReminderEnabled: document.getElementById("opt-break-reminder-enabled") as HTMLInputElement,
  breakReminderHint: document.getElementById("opt-break-reminder-hint") as HTMLElement | null,
  themeRadios: Array.from(
    document.querySelectorAll<HTMLInputElement>('input[name="theme"]'),
  ),
  premiumStatus: document.getElementById("premium-status") as HTMLElement,
  btnUpgrade: document.getElementById("btn-upgrade") as HTMLButtonElement,
  premiumLicense: document.getElementById("premium-license") as HTMLElement | null,
  licenseKey: document.getElementById("opt-license-key") as HTMLInputElement | null,
  btnApplyLicense: document.getElementById("btn-apply-license") as HTMLButtonElement | null,
  licenseFeedback: document.getElementById("license-feedback") as HTMLElement | null,
  btnReset: document.getElementById("btn-reset") as HTMLButtonElement,
  savedIndicator: document.getElementById("saved-indicator") as HTMLElement,
  stats7days: document.getElementById("stats-7days") as HTMLElement | null,
  statsEmpty: document.getElementById("stats-empty") as HTMLElement | null,
  statsPremium: document.getElementById("stats-premium") as HTMLElement | null,
  statsPremiumChart: document.getElementById("stats-premium-chart") as HTMLElement | null,
  statsPremiumUpgrade: document.getElementById("stats-premium-upgrade") as HTMLElement | null,
  statsTotalFocusMin: document.getElementById("stats-total-focus-min") as HTMLElement | null,
  statsTotalSessions: document.getElementById("stats-total-sessions") as HTMLElement | null,
  statsTab30: document.getElementById("stats-tab-30") as HTMLButtonElement | null,
  statsTab90: document.getElementById("stats-tab-90") as HTMLButtonElement | null,
  btnExportCsv: document.getElementById("btn-export-csv") as HTMLButtonElement | null,
  btnClearStats: document.getElementById("btn-clear-stats") as HTMLButtonElement | null,
  confirmDialog: document.getElementById("confirm-action") as HTMLDialogElement | null,
  confirmTitle: document.getElementById("confirm-title") as HTMLElement | null,
  confirmBody: document.getElementById("confirm-body") as HTMLElement | null,
};

let premiumRange: 30 | 90 = 30;

let savedIndicatorTimeout: number | undefined;

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.sound_volume;
  return Math.min(1, Math.max(0, value));
}

function applyNotificationUiState(
  settings: Pick<Settings, "notification_enabled">,
): void {
  // Master switch — when notifications are off the dependent reminder toggle
  // can't do anything, so disable + dim it to match its no-op behavior.
  const off = !settings.notification_enabled;
  els.breakReminderEnabled.disabled = off;
  els.breakReminderEnabled.closest(".toggle")?.classList.toggle("is-disabled", off);
  els.breakReminderHint?.classList.toggle("is-disabled", off);
}

function checkNotificationPermission(): void {
  // chrome.notifications.getPermissionLevel returns "granted" or "denied".
  // We only surface the denied hint when the user has the master switch on;
  // otherwise the reminder is intentionally suppressed and the warning would
  // be confusing.
  const api = (chrome as unknown as {
    notifications?: {
      getPermissionLevel?: (cb: (level: string) => void) => void;
    };
  }).notifications;
  const hint = els.notificationDeniedHint;
  if (!hint) return;
  if (!api || typeof api.getPermissionLevel !== "function") {
    hint.hidden = true;
    return;
  }
  try {
    api.getPermissionLevel((level) => {
      const denied = level === "denied" && els.notificationEnabled.checked;
      hint.hidden = !denied;
    });
  } catch {
    hint.hidden = true;
  }
}

function applySoundUiState(settings: Pick<Settings, "sound_enabled" | "child_mode">): void {
  // sound_enabled is the master switch — disabling it also disables the volume
  // slider so the UI matches sound.ts's "no-op when disabled" contract.
  els.soundVolume.disabled = !settings.sound_enabled;
  els.soundVolume.classList.toggle("is-disabled", !settings.sound_enabled);
  if (els.soundVolumeChildHint) {
    els.soundVolumeChildHint.hidden = !settings.child_mode;
  }
  if (els.btnSoundTest) {
    els.btnSoundTest.disabled = !settings.sound_enabled;
  }
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
  // Surface the clamp visually so child-mode users see the cap, not the raw value.
  const displayVolume = clampVolumeForMode(settings.sound_volume, settings.child_mode);
  els.soundVolume.value = String(displayVolume);
  els.soundVolumeOut.value = `${Math.round(displayVolume * 100)}%`;
  els.notificationEnabled.checked = settings.notification_enabled;
  els.breakReminderEnabled.checked = settings.break_reminder_enabled;
  for (const radio of els.themeRadios) {
    radio.checked = radio.value === settings.theme;
  }
  renderTheme(settings.theme);
  els.body.classList.toggle("child-mode", settings.child_mode);
  applySoundUiState(settings);
  applyNotificationUiState(settings);
  checkNotificationPermission();
}

function readForm(): Settings {
  const themeRadio = els.themeRadios.find((r) => r.checked);
  const themeValue = themeRadio?.value ?? DEFAULT_SETTINGS.theme;
  const langValue = els.language.value;
  const childMode = els.childMode.checked;
  // Persist the clamped value so the cap survives a child-mode toggle later.
  const volume = clampVolumeForMode(
    clampVolume(Number(els.soundVolume.value)),
    childMode,
  );

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
    sound_volume: volume,
    notification_enabled: els.notificationEnabled.checked,
    break_reminder_enabled: els.breakReminderEnabled.checked,
    child_mode: childMode,
    language: isLanguage(langValue) ? langValue : DEFAULT_SETTINGS.language,
  };
}

function renderPremium(premium: Premium): void {
  const now = Date.now();
  const unlocked = isPremium(premium);
  const inTrial = isTrial(premium, now);

  let key: "options_premium_status_unlocked" | "options_premium_status_trial" | "options_premium_status_free";
  if (unlocked) {
    key = "options_premium_status_unlocked";
  } else if (inTrial) {
    key = "options_premium_status_trial";
  } else {
    key = "options_premium_status_free";
  }
  // Append the day count for trial so the user always knows how long is left
  // without having to click anywhere; the base i18n string stays short.
  const baseLabel = t(key);
  if (inTrial) {
    const daysLeft = Math.max(1, trialDaysLeft(premium, now));
    els.premiumStatus.textContent = `${baseLabel} (${t("popup_trial_days_left", String(daysLeft))})`;
  } else {
    els.premiumStatus.textContent = baseLabel;
  }
  els.premiumStatus.dataset.i18n = key;
  // Visual tier hint for CSS/tests. Avoids hard-coding the same predicate at
  // every selector site.
  els.body.dataset.premiumTier = unlocked ? "premium" : inTrial ? "trial" : "free";
  els.btnUpgrade.disabled = unlocked;
  // License entry only makes sense before purchase — hide once unlocked so the
  // section can't accidentally re-trigger the "applied" toast.
  if (els.premiumLicense) {
    els.premiumLicense.hidden = unlocked;
  }
  if (unlocked && els.licenseFeedback) {
    els.licenseFeedback.hidden = true;
  }
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

function formatRowAriaLabel(date: string, focusMin: number, sessions: number): string {
  const localized = formatRowDate(date);
  return t("options_stats_row_label", [localized, String(focusMin), String(sessions)]);
}

function formatRowDate(isoDate: string): string {
  // YYYY-MM-DD → M/D (locale-neutral; Intl is overkill for the bar labels and
  // would balloon bundle size in the service worker too).
  const [, m, d] = isoDate.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function renderChart(
  container: HTMLElement,
  rows: Array<{ date: string; focus_min: number; sessions: number }>,
): void {
  container.replaceChildren();
  if (rows.length === 0) return;
  const max = rows.reduce((acc, r) => Math.max(acc, r.focus_min), 0);
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "stats-row";
    item.setAttribute("role", "listitem");
    item.setAttribute("aria-label", formatRowAriaLabel(row.date, row.focus_min, row.sessions));

    const dateEl = document.createElement("span");
    dateEl.className = "stats-row__date";
    dateEl.textContent = formatRowDate(row.date);

    const track = document.createElement("div");
    track.className = "stats-row__track";
    track.setAttribute("aria-hidden", "true");
    const bar = document.createElement("div");
    bar.className = "stats-row__bar";
    const pct = max > 0 ? (row.focus_min / max) * 100 : 0;
    bar.style.width = `${pct}%`;
    track.appendChild(bar);

    const value = document.createElement("span");
    value.className = "stats-row__value";
    value.textContent = `${row.focus_min}${t("options_stats_minutes_unit")} / ${row.sessions}${t("options_stats_sessions_unit")}`;

    item.append(dateEl, track, value);
    container.appendChild(item);
  }
}

function renderStats(stats: Stats, premium: Premium): void {
  const now = Date.now();
  const sevenDays = lastNDays(stats, 7, now);
  const hasAny =
    sevenDays.some((d) => d.focus_min > 0 || d.sessions > 0) ||
    stats.total_sessions > 0;

  if (els.stats7days) {
    renderChart(els.stats7days, sevenDays);
  }
  if (els.statsEmpty) {
    els.statsEmpty.hidden = hasAny;
  }

  const premiumOn = hasPremiumAccess(premium, now);
  if (els.statsPremium) els.statsPremium.hidden = !premiumOn;
  if (els.statsPremiumUpgrade) els.statsPremiumUpgrade.hidden = premiumOn;

  if (premiumOn) {
    const range = premiumRange;
    if (els.statsPremiumChart) {
      renderChart(els.statsPremiumChart, lastNDays(stats, range, now));
      els.statsPremiumChart.setAttribute(
        "aria-labelledby",
        range === 30 ? "stats-tab-30" : "stats-tab-90",
      );
    }
    if (els.statsTotalFocusMin) {
      els.statsTotalFocusMin.textContent = String(stats.total_focus_min);
    }
    if (els.statsTotalSessions) {
      els.statsTotalSessions.textContent = String(stats.total_sessions);
    }
    if (els.statsTab30) {
      const active = range === 30;
      els.statsTab30.classList.toggle("is-active", active);
      els.statsTab30.setAttribute("aria-selected", active ? "true" : "false");
    }
    if (els.statsTab90) {
      const active = range === 90;
      els.statsTab90.classList.toggle("is-active", active);
      els.statsTab90.setAttribute("aria-selected", active ? "true" : "false");
    }
  }
}

async function loadAndRender(): Promise<void> {
  const { settings, premium, stats } = (await chrome.storage.local.get([
    "settings",
    "premium",
    "stats",
  ])) as { settings?: Settings; premium?: Premium; stats?: Stats };

  const effectivePremium =
    premium ?? { trial_start_ts: Date.now(), premium_unlocked: false };
  renderForm({ ...DEFAULT_SETTINGS, ...(settings ?? {}) });
  renderPremium(effectivePremium);
  renderStats(stats ?? DEFAULT_STATS, effectivePremium);
}

function confirmAction(titleKey: MessageKey, bodyKey: MessageKey): Promise<boolean> {
  const dialog = els.confirmDialog;
  const titleEl = els.confirmTitle;
  const bodyEl = els.confirmBody;
  if (!dialog || !titleEl || !bodyEl || typeof dialog.showModal !== "function") {
    // Fall through to `confirm()` so headless / older runtimes still get a
    // prompt rather than silently destroying data.
    return Promise.resolve(window.confirm(`${t(titleKey)}\n\n${t(bodyKey)}`));
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

async function clearStats(): Promise<void> {
  const ok = await confirmAction(
    "options_stats_clear_confirm_title",
    "options_stats_clear_confirm_body",
  );
  if (!ok) return;
  await chrome.storage.local.set({ stats: DEFAULT_STATS });
}

function statsToCsv(stats: Stats): string {
  const header = "date,focus_min,sessions";
  const rows = Object.keys(stats.daily)
    .sort()
    .map((date) => {
      const day = stats.daily[date];
      return `${date},${day.focus_min},${day.sessions}`;
    });
  return [header, ...rows].join("\n") + "\n";
}

async function exportCsv(): Promise<void> {
  const { stats } = (await chrome.storage.local.get("stats")) as { stats?: Stats };
  const csv = statsToCsv(stats ?? DEFAULT_STATS);
  // data: URL keeps us off the `downloads` permission. The CSV is at most
  // ~100 days × ~30 bytes = ~3KB so the URL length is well within limits.
  const dataUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = `focus-timer-stats-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function showLicenseFeedback(messageKey: MessageKey, kind: "error" | "success"): void {
  const el = els.licenseFeedback;
  if (!el) return;
  el.textContent = t(messageKey);
  el.classList.toggle("is-error", kind === "error");
  el.classList.toggle("is-success", kind === "success");
  el.hidden = false;
}

async function handleApplyLicense(): Promise<void> {
  const input = els.licenseKey;
  if (!input) return;
  const raw = input.value;
  const result = await applyLicenseKey(raw);
  if (result === null) {
    showLicenseFeedback("options_premium_license_invalid", "error");
    input.focus();
    input.select();
    return;
  }
  showLicenseFeedback("options_premium_license_applied", "success");
  input.value = "";
  // renderPremium runs via the storage watcher (premium changes), which will
  // hide the entry section and disable the upgrade button.
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
    // Reapply the cap to the live slider so the preview matches what would be saved.
    const next = clampVolumeForMode(
      Number(els.soundVolume.value),
      els.childMode.checked,
    );
    els.soundVolume.value = String(next);
    els.soundVolumeOut.value = `${Math.round(next * 100)}%`;
    applySoundUiState({
      sound_enabled: els.soundEnabled.checked,
      child_mode: els.childMode.checked,
    });
  });

  els.soundEnabled.addEventListener("change", () => {
    applySoundUiState({
      sound_enabled: els.soundEnabled.checked,
      child_mode: els.childMode.checked,
    });
  });

  els.notificationEnabled.addEventListener("change", () => {
    applyNotificationUiState({ notification_enabled: els.notificationEnabled.checked });
    checkNotificationPermission();
  });

  els.soundVolume.addEventListener("input", () => {
    const next = clampVolumeForMode(
      Number(els.soundVolume.value),
      els.childMode.checked,
    );
    if (Number(els.soundVolume.value) !== next) {
      els.soundVolume.value = String(next);
    }
    els.soundVolumeOut.value = `${Math.round(next * 100)}%`;
  });

  els.btnSoundTest?.addEventListener("click", () => {
    void (async () => {
      const childMode = els.childMode.checked;
      const settings = {
        ...DEFAULT_SETTINGS,
        sound_enabled: els.soundEnabled.checked,
        sound_volume: clampVolumeForMode(Number(els.soundVolume.value), childMode),
        child_mode: childMode,
      } as Settings;
      await playPhaseTransition("work", settings);
    })();
  });

  els.btnUpgrade.addEventListener("click", () => {
    // Suppress double-clicks until the new tab actually opens; openCheckout
    // is fire-and-forget (the user pays in the new tab and pastes the license
    // key back into the input below).
    els.btnUpgrade.disabled = true;
    void openCheckout().finally(() => {
      window.setTimeout(() => {
        els.btnUpgrade.disabled = false;
      }, 600);
    });
  });

  els.btnApplyLicense?.addEventListener("click", () => {
    void handleApplyLicense();
  });
  els.licenseKey?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleApplyLicense();
    }
  });

  els.btnClearStats?.addEventListener("click", () => {
    void clearStats();
  });
  els.btnExportCsv?.addEventListener("click", () => {
    void exportCsv();
  });
  els.statsTab30?.addEventListener("click", () => {
    if (premiumRange === 30) return;
    premiumRange = 30;
    void loadAndRender();
  });
  els.statsTab90?.addEventListener("click", () => {
    if (premiumRange === 90) return;
    premiumRange = 90;
    void loadAndRender();
  });
}

function watchStorage(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("premium" in changes || "settings" in changes || "stats" in changes) {
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
