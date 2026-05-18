/**
 * i18n.ts — typed bridge over chrome.i18n.
 *
 * Centralises the message-key catalogue so popup/options/background reference
 * a single `MessageKey` union and the TypeScript compiler flags typos before
 * they hit the bundle. The runtime helpers also act as a fallback layer: if
 * chrome.i18n returns an empty string (key missing in _locales/), `t()`
 * returns the key itself so UI stays debuggable instead of blank.
 */

export type MessageKey =
  | "appName"
  | "appDesc"
  | "popup_title"
  | "popup_start"
  | "popup_pause"
  | "popup_resume"
  | "popup_reset"
  | "popup_skip"
  | "popup_mode_work"
  | "popup_mode_break"
  | "popup_mode_long_break"
  | "popup_time_left"
  | "popup_session_count"
  | "popup_focus_min_today"
  | "popup_child_mode"
  | "popup_child_mode_on"
  | "popup_child_mode_off"
  | "popup_confirm_reset_title"
  | "popup_confirm_reset_body"
  | "popup_confirm_skip_title"
  | "popup_confirm_skip_body"
  | "popup_mute"
  | "popup_unmute"
  | "popup_sound_on"
  | "popup_sound_off"
  | "popup_settings"
  | "popup_break_reminder"
  | "popup_break_reminder_body"
  | "popup_break_reminder_idle_title"
  | "popup_break_reminder_idle_body"
  | "popup_session_complete"
  | "popup_session_complete_body"
  | "popup_premium_badge"
  | "popup_trial_active"
  | "popup_trial_days_left"
  | "options_title"
  | "options_section_timer"
  | "options_section_appearance"
  | "options_section_sound"
  | "options_section_notifications"
  | "options_section_premium"
  | "options_work_duration"
  | "options_break_duration"
  | "options_long_break_duration"
  | "options_sessions_until_long_break"
  | "options_auto_start_break"
  | "options_auto_start_work"
  | "options_theme"
  | "options_theme_light"
  | "options_theme_dark"
  | "options_theme_system"
  | "options_sound_enabled"
  | "options_sound_volume"
  | "options_sound_hint"
  | "options_sound_test"
  | "options_sound_volume_child_hint"
  | "options_notification_enabled"
  | "options_break_reminder_enabled"
  | "options_break_reminder_hint"
  | "options_notification_denied_hint"
  | "options_child_mode_label"
  | "options_child_mode_desc"
  | "options_language"
  | "options_save"
  | "options_saved"
  | "options_reset_defaults"
  | "options_premium_status_free"
  | "options_premium_status_trial"
  | "options_premium_status_unlocked"
  | "options_premium_upgrade"
  | "options_premium_price"
  | "options_premium_features"
  | "options_premium_license_label"
  | "options_premium_license_hint"
  | "options_premium_license_apply"
  | "options_premium_license_invalid"
  | "options_premium_license_applied"
  | "options_privacy_link"
  | "options_terms_link"
  | "stats_title"
  | "stats_today"
  | "stats_week"
  | "stats_all_time"
  | "stats_focus_minutes"
  | "stats_sessions_completed"
  | "stats_premium_locked"
  | "options_stats_7days_title"
  | "options_stats_30days_title"
  | "options_stats_90days_title"
  | "options_stats_premium_title"
  | "options_stats_total_focus_min"
  | "options_stats_total_sessions"
  | "options_stats_clear"
  | "options_stats_clear_confirm_title"
  | "options_stats_clear_confirm_body"
  | "options_stats_export_csv"
  | "options_stats_premium_upgrade"
  | "options_stats_empty"
  | "options_stats_row_label"
  | "options_stats_minutes_unit"
  | "options_stats_sessions_unit"
  | "options_stats_tab_30"
  | "options_stats_tab_90"
  | "options_section_data"
  | "options_data_hint"
  | "options_data_export"
  | "options_data_import"
  | "options_data_import_confirm_title"
  | "options_data_import_confirm_body"
  | "options_data_import_invalid"
  | "options_data_import_success"
  | "common_yes"
  | "common_no"
  | "common_close"
  | "common_cancel"
  | "common_ok"
  | "common_error"
  | "common_minutes"
  | "common_seconds";

/**
 * Translate a message key. Falls back to the key string itself when the
 * locale file is missing the entry, so a typo is obvious in the UI rather
 * than rendering as an empty span.
 */
export function t(key: MessageKey, substitutions?: string | string[]): string {
  const value = chrome.i18n.getMessage(key, substitutions);
  return value || key;
}

/** Returns Chrome's resolved UI language (e.g. "ja", "en-US"). */
export function getUILanguage(): string {
  return chrome.i18n.getUILanguage();
}

/**
 * Walk a DOM subtree and apply translations declared via data attributes:
 * `data-i18n` rewrites textContent, `data-i18n-attr="attr:key;attr2:key2"`
 * rewrites attribute values, and `data-i18n-title` sets document.title.
 * Idempotent — safe to call again after dynamic DOM insertions.
 */
export function applyI18nToDom(root: ParentNode = document): void {
  const textNodes = root.querySelectorAll<HTMLElement>("[data-i18n]");
  textNodes.forEach((el) => {
    const key = el.dataset.i18n as MessageKey | undefined;
    if (key) el.textContent = t(key);
  });

  const attrNodes = root.querySelectorAll<HTMLElement>("[data-i18n-attr]");
  attrNodes.forEach((el) => {
    const spec = el.dataset.i18nAttr;
    if (!spec) return;
    // Format: "attr1:key1;attr2:key2"
    spec.split(";").forEach((pair) => {
      const [attr, key] = pair.split(":").map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key as MessageKey));
    });
  });

  const titleEl = root.querySelector<HTMLElement>("[data-i18n-title]");
  if (titleEl) {
    const key = titleEl.dataset.i18nTitle as MessageKey | undefined;
    if (key) document.title = t(key);
  }
}
