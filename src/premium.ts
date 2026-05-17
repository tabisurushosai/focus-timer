/**
 * premium.ts — single source for trial/Premium status logic.
 *
 * The Premium state itself (trial_start_ts, premium_unlocked) lives in
 * chrome.storage.local under the `premium` key; this module is the only place
 * that interprets it. Popup, options page, and any future gates should call
 * the helpers here rather than re-deriving the elapsed-trial-day arithmetic.
 *
 * Pure predicates (isPremium / isTrial / hasPremiumAccess / trialDaysLeft /
 * premiumTier) take the Premium record and `now` so they stay testable under
 * Node's built-in test runner without faking chrome.*. The async helpers
 * (getPremium / ensureTrialStarted / unlockPremium / lockPremium) wrap
 * storage.ts and are the entry points the rest of the codebase should use.
 */

import {
  TRIAL_DAYS,
  createDefaultPremium,
  get,
  patch,
  set,
  type Premium,
} from "./storage.ts";

export { TRIAL_DAYS } from "./storage.ts";
export type { Premium } from "./storage.ts";

/** Three-way status used by UI gates. */
export type PremiumTier = "premium" | "trial" | "free";

const DAY_MS = 86_400_000;

/** True when the user has paid for the unlock. Does not consider trial. */
export function isPremium(premium: Premium): boolean {
  return premium.premium_unlocked === true;
}

/**
 * True while the unlock flag is false and the trial window has not elapsed.
 * Returns false if trial_start_ts is missing (caller should bootstrap via
 * ensureTrialStarted before checking).
 */
export function isTrial(premium: Premium, now: number = Date.now()): boolean {
  if (premium.premium_unlocked) return false;
  if (!premium.trial_start_ts) return false;
  const elapsedDays = (now - premium.trial_start_ts) / DAY_MS;
  return elapsedDays < TRIAL_DAYS;
}

/** True if Premium features should be available (unlocked OR in trial). */
export function hasPremiumAccess(premium: Premium, now: number = Date.now()): boolean {
  return isPremium(premium) || isTrial(premium, now);
}

/** Whole days remaining in the trial, clamped to [0, TRIAL_DAYS]. */
export function trialDaysLeft(premium: Premium, now: number = Date.now()): number {
  if (premium.premium_unlocked || !premium.trial_start_ts) return 0;
  const elapsedDays = (now - premium.trial_start_ts) / DAY_MS;
  return Math.max(0, Math.ceil(TRIAL_DAYS - elapsedDays));
}

/** Coarse three-way status; convenient for switch-based UI branching. */
export function premiumTier(premium: Premium, now: number = Date.now()): PremiumTier {
  if (isPremium(premium)) return "premium";
  if (isTrial(premium, now)) return "trial";
  return "free";
}

/** Read the current premium record (with defaults if absent). */
export async function getPremium(): Promise<Premium> {
  return get("premium");
}

/**
 * Make sure trial_start_ts has a value. Idempotent — preserves an existing
 * timestamp so the trial clock can't be reset by re-opening the popup. Returns
 * the resulting record so callers can immediately read tier/days-left without
 * a second storage round-trip.
 */
export async function ensureTrialStarted(now: number = Date.now()): Promise<Premium> {
  const current = await get("premium");
  if (current.trial_start_ts && current.trial_start_ts > 0) return current;
  const next: Premium = { ...current, trial_start_ts: now };
  await set("premium", next);
  return next;
}

/** Flip premium_unlocked=true. Trial timestamp is preserved for diagnostics. */
export async function unlockPremium(): Promise<Premium> {
  return patch("premium", { premium_unlocked: true });
}

/**
 * Reset to a fresh free state — both flags cleared. Intended for the dev/test
 * surface and a future "restore purchases failed → revoke" path; not wired to
 * any user-facing button.
 */
export async function lockPremium(now: number = Date.now()): Promise<Premium> {
  const fresh = createDefaultPremium(now);
  await set("premium", fresh);
  return fresh;
}
