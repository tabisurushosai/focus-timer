/**
 * sound.ts — single window for playing the phase-transition chime.
 *
 * MV3 service workers cannot use Web Audio directly, so playback is delegated
 * to an offscreen document (created on demand) that listens for `sound_play`
 * messages and synthesises the chime with AudioContext. This module owns the
 * lifecycle: ensure-or-create the document, post the message, swallow
 * recoverable errors so audio failures never break the timer's primary path.
 *
 * Design: docs/design-sound-mute.md.
 */

import type { Settings } from "./storage";

export type PhaseTone = "work" | "break" | "long_break";

/** Minimum gap between two chime triggers; collapses rapid skips into one tone. */
export const DEBOUNCE_MS = 100;

/** Upper bound on volume when child_mode is on (protects against startle). */
export const CHILD_VOLUME_CAP = 0.8;

/** Default volume used when the stored value is not a finite number. */
export const FALLBACK_VOLUME = 0.6;

const OFFSCREEN_URL = "offscreen.html";
const OFFSCREEN_JUSTIFICATION =
  "Play phase-transition chime for the focus timer.";

/** True when the user wants audio: enabled AND non-zero volume. */
export function isSoundActive(settings: Settings): boolean {
  return settings.sound_enabled && settings.sound_volume > 0;
}

/** Clamp a raw volume to [0,1], capping at CHILD_VOLUME_CAP when childMode. */
export function clampVolumeForMode(volume: number, childMode: boolean): number {
  if (!Number.isFinite(volume)) return FALLBACK_VOLUME;
  const clamped = Math.min(1, Math.max(0, volume));
  return childMode ? Math.min(CHILD_VOLUME_CAP, clamped) : clamped;
}

/** Effective playback volume given the full settings snapshot. */
export function effectiveVolume(settings: Settings): number {
  return clampVolumeForMode(settings.sound_volume, settings.child_mode);
}

type OffscreenApi = {
  hasDocument?: () => Promise<boolean>;
  createDocument: (opts: {
    url: string;
    reasons: string[];
    justification: string;
  }) => Promise<void>;
};

function getOffscreenApi(): OffscreenApi | null {
  const off = (chrome as unknown as { offscreen?: OffscreenApi }).offscreen;
  if (!off || typeof off.createDocument !== "function") return null;
  return off;
}

async function ensureOffscreenDocument(): Promise<boolean> {
  const off = getOffscreenApi();
  if (!off) return false;
  try {
    if (typeof off.hasDocument === "function") {
      if (await off.hasDocument()) return true;
    }
    await off.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["AUDIO_PLAYBACK"],
      justification: OFFSCREEN_JUSTIFICATION,
    });
    return true;
  } catch (err) {
    // Chrome rejects concurrent creates with "Only a single offscreen document";
    // treat the race as success so we still post the message.
    if (err instanceof Error && /single offscreen/i.test(err.message)) {
      return true;
    }
    console.warn("offscreen create failed", err);
    return false;
  }
}

/**
 * Mutable debounce anchor. Module-level so back-to-back skips coalesce within
 * the same service-worker lifetime; resets on cold start, which is fine — a
 * fresh worker after wake means the user paused long enough to deserve a tone.
 */
let lastPlayedTs = 0;

/** Test seam: reset debounce so the unit tests start from a known state. */
export function _resetDebounceForTests(): void {
  lastPlayedTs = 0;
}

/**
 * Play the chime for a phase transition. No-op when sound is disabled, volume
 * is 0, the offscreen API is unavailable, or the previous tone fired within
 * DEBOUNCE_MS. Always resolves; exceptions are logged and swallowed so the
 * caller's primary path (the actual phase change) cannot be broken by audio.
 */
export async function playPhaseTransition(
  _to: PhaseTone,
  settings: Settings,
  now: number = Date.now(),
): Promise<void> {
  if (!isSoundActive(settings)) return;
  if (now - lastPlayedTs < DEBOUNCE_MS) return;
  lastPlayedTs = now;
  const ok = await ensureOffscreenDocument();
  if (!ok) return;
  try {
    await chrome.runtime.sendMessage({
      type: "sound_play",
      volume: effectiveVolume(settings),
    });
  } catch (err) {
    console.warn("sound_play send failed", err);
  }
}
