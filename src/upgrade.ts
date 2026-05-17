/**
 * upgrade.ts — Premium purchase flow (Stripe Checkout + license unlock).
 *
 * The extension has no backend, so Premium is bought through a pre-configured
 * Stripe Payment Link (a static `buy.stripe.com/...` URL). The flow:
 *
 *   1. user clicks "Upgrade" → openCheckout() opens the Payment Link in a new
 *      tab; the extension makes no network requests itself.
 *   2. Stripe collects payment and emails the user a license key.
 *   3. user pastes the key into the options page → applyLicenseKey() validates
 *      the format and flips premium_unlocked=true via premium.unlockPremium().
 *
 * No PII is sent to Stripe by us — the Payment Link is opened as-is. The
 * validator is intentionally a format check, not a signed-secret check: for a
 * $3 buy-once unlock the realistic threat model treats keys as a courtesy lock
 * rather than DRM. Keys are uppercase hex grouped as XXXX-XXXX-XXXX-XXXX so
 * users can read them off an email without confusing 0/O or 1/I.
 */

import { lockPremium, unlockPremium, type Premium } from "./premium.ts";

/**
 * Placeholder Stripe Payment Link. Replace with the real `buy.stripe.com/...`
 * URL before release. Kept as a constant so build-time substitution stays
 * trivial (single line) and the URL is greppable.
 */
export const STRIPE_CHECKOUT_URL = "https://buy.stripe.com/focus-timer-premium";

/** Accept hex groups separated by hyphens; case-insensitive but normalized upstream. */
const LICENSE_KEY_RE = /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/;

export type BuildCheckoutOptions = {
  /**
   * Opaque per-install id forwarded as Stripe's client_reference_id so the
   * dashboard can correlate a refund/license-revoke request back to a single
   * install without us collecting any identifier ourselves. Optional.
   */
  installId?: string;
  locale?: "ja" | "en";
};

/**
 * Assemble the Payment Link URL. Pure (no chrome.* / network) so the
 * resulting URL can be unit-tested and embedded into a button click without
 * an extra round-trip.
 */
export function buildCheckoutUrl(options: BuildCheckoutOptions = {}): string {
  const url = new URL(STRIPE_CHECKOUT_URL);
  if (options.installId && /^[A-Za-z0-9_-]{1,64}$/.test(options.installId)) {
    url.searchParams.set("client_reference_id", options.installId);
  }
  if (options.locale === "ja" || options.locale === "en") {
    url.searchParams.set("locale", options.locale);
  }
  return url.toString();
}

/**
 * Open the Payment Link in a new tab. Prefers chrome.tabs.create (Chrome
 * extension context); falls back to window.open from a regular HTML page.
 * Returns false when neither path is available (e.g. unit-test / SSR).
 */
export async function openCheckout(options: BuildCheckoutOptions = {}): Promise<boolean> {
  const url = buildCheckoutUrl(options);
  const tabs = (chrome as unknown as {
    tabs?: { create?: (props: { url: string }) => Promise<chrome.tabs.Tab> | void };
  }).tabs;
  if (tabs && typeof tabs.create === "function") {
    try {
      await tabs.create({ url });
      return true;
    } catch {
      // fall through to window.open
    }
  }
  if (typeof window !== "undefined" && typeof window.open === "function") {
    const handle = window.open(url, "_blank", "noopener,noreferrer");
    return handle !== null;
  }
  return false;
}

/**
 * True iff `input` matches the license-key shape. Trims whitespace and
 * upper-cases; reject anything else so accidental "i typed extra dashes"
 * doesn't silently pass.
 */
export function isValidLicenseKey(input: string): boolean {
  if (typeof input !== "string") return false;
  return LICENSE_KEY_RE.test(input.trim().toUpperCase());
}

/**
 * Validate the supplied key; on success, flip premium_unlocked=true and
 * return the updated record. Returns null when validation fails so callers
 * can surface a localized error without inspecting exceptions.
 */
export async function applyLicenseKey(input: string): Promise<Premium | null> {
  if (!isValidLicenseKey(input)) return null;
  return unlockPremium();
}

/**
 * Dev/test surface: revoke a previously-applied unlock. Not wired to any
 * user-facing button — useful when troubleshooting a refund or re-testing
 * the trial path without reinstalling.
 */
export async function revokePurchase(): Promise<Premium> {
  return lockPremium();
}
