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
  | "popup_child_mode"
  | "popup_child_mode_on"
  | "popup_child_mode_off"
  | "popup_confirm_reset_title"
  | "popup_confirm_reset_body"
  | "popup_confirm_skip_title"
  | "popup_confirm_skip_body"
  | "popup_mute"
  | "popup_unmute"
  | "popup_settings"
  | "popup_break_reminder"
  | "popup_break_reminder_body"
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
  | "options_notification_enabled"
  | "options_break_reminder_enabled"
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
  | "options_privacy_link"
  | "options_terms_link"
  | "stats_title"
  | "stats_today"
  | "stats_week"
  | "stats_all_time"
  | "stats_focus_minutes"
  | "stats_sessions_completed"
  | "stats_premium_locked"
  | "common_yes"
  | "common_no"
  | "common_close"
  | "common_cancel"
  | "common_ok"
  | "common_error"
  | "common_minutes"
  | "common_seconds";

export function t(key: MessageKey, substitutions?: string | string[]): string {
  const value = chrome.i18n.getMessage(key, substitutions);
  return value || key;
}

export function getUILanguage(): string {
  return chrome.i18n.getUILanguage();
}

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
