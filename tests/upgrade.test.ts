/**
 * Tests for upgrade (T033) — contract checks for src/upgrade.ts plus
 * integration pins on the options-page wiring. The actual Stripe Checkout
 * page can't be exercised under Node, so these tests cover:
 *
 *  - buildCheckoutUrl: pure URL assembly + optional client_reference_id /
 *    locale params, with input sanitization
 *  - openCheckout: prefers chrome.tabs.create, falls back to window.open,
 *    no-ops cleanly when neither path exists
 *  - isValidLicenseKey: format guard accepts the canonical XXXX-XXXX-XXXX-XXXX
 *    shape (case-insensitive, trimmed) and rejects everything else
 *  - applyLicenseKey: returns null on bad input (no storage write) and
 *    delegates to unlockPremium on success
 *  - i18n keys exist in both ja and en locales
 *  - options.html exposes the license entry section + apply button
 *  - options.ts wires btn-upgrade → openCheckout and btn-apply-license →
 *    applyLicenseKey
 *
 * Run with: npm test (uses Node's built-in --test + --experimental-strip-types).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  STRIPE_CHECKOUT_URL,
  applyLicenseKey,
  buildCheckoutUrl,
  isValidLicenseKey,
  openCheckout,
} from "../src/upgrade.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function readText(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

function readJson(rel: string): Record<string, { message: string }> {
  return JSON.parse(readText(rel));
}

const UPGRADE_I18N_KEYS = [
  "options_premium_status_free",
  "options_premium_status_trial",
  "options_premium_status_unlocked",
  "options_premium_upgrade",
  "options_premium_price",
  "options_premium_features",
  "options_premium_license_label",
  "options_premium_license_hint",
  "options_premium_license_apply",
  "options_premium_license_invalid",
  "options_premium_license_applied",
] as const;

describe("upgrade: i18n keys", () => {
  const ja = readJson("_locales/ja/messages.json");
  const en = readJson("_locales/en/messages.json");

  for (const key of UPGRADE_I18N_KEYS) {
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

describe("upgrade: STRIPE_CHECKOUT_URL", () => {
  it("is an https URL (Stripe payment links are always https)", () => {
    assert.ok(STRIPE_CHECKOUT_URL.startsWith("https://"), `expected https, got: ${STRIPE_CHECKOUT_URL}`);
  });

  it("parses as a URL", () => {
    assert.doesNotThrow(() => new URL(STRIPE_CHECKOUT_URL));
  });
});

describe("upgrade: buildCheckoutUrl", () => {
  it("returns the bare URL when no options are passed", () => {
    const url = buildCheckoutUrl();
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("client_reference_id"), null);
    assert.equal(parsed.searchParams.get("locale"), null);
  });

  it("forwards a safe installId as client_reference_id", () => {
    const url = buildCheckoutUrl({ installId: "abc_123-XYZ" });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("client_reference_id"), "abc_123-XYZ");
  });

  it("rejects installId that contains unexpected characters", () => {
    const url = buildCheckoutUrl({ installId: "abc 123 with spaces!" });
    const parsed = new URL(url);
    // Sanitization failed → param not appended.
    assert.equal(parsed.searchParams.get("client_reference_id"), null);
  });

  it("rejects installId that is longer than 64 chars", () => {
    const tooLong = "a".repeat(65);
    const url = buildCheckoutUrl({ installId: tooLong });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("client_reference_id"), null);
  });

  it("forwards a known locale verbatim", () => {
    assert.equal(
      new URL(buildCheckoutUrl({ locale: "ja" })).searchParams.get("locale"),
      "ja",
    );
    assert.equal(
      new URL(buildCheckoutUrl({ locale: "en" })).searchParams.get("locale"),
      "en",
    );
  });
});

describe("upgrade: isValidLicenseKey", () => {
  it("accepts the canonical XXXX-XXXX-XXXX-XXXX hex form", () => {
    assert.equal(isValidLicenseKey("ABCD-1234-EF56-7890"), true);
    assert.equal(isValidLicenseKey("0000-0000-0000-0000"), true);
    assert.equal(isValidLicenseKey("FFFF-FFFF-FFFF-FFFF"), true);
  });

  it("is case-insensitive (lower-case keys are accepted after trim/upper)", () => {
    assert.equal(isValidLicenseKey("abcd-1234-ef56-7890"), true);
  });

  it("trims surrounding whitespace before validating", () => {
    assert.equal(isValidLicenseKey("  ABCD-1234-EF56-7890  "), true);
    assert.equal(isValidLicenseKey("\n\tABCD-1234-EF56-7890\n"), true);
  });

  it("rejects malformed keys", () => {
    assert.equal(isValidLicenseKey(""), false);
    assert.equal(isValidLicenseKey("ABCD"), false);
    assert.equal(isValidLicenseKey("ABCD-1234-EF56"), false);
    assert.equal(isValidLicenseKey("ABCD-1234-EF56-78901"), false);
    assert.equal(isValidLicenseKey("ABCD-1234-EF56-789G"), false); // G is not hex
    assert.equal(isValidLicenseKey("ABCD 1234 EF56 7890"), false); // spaces, not dashes
    assert.equal(isValidLicenseKey("ABCD1234EF567890"), false); // no dashes at all
  });

  it("rejects non-string inputs without throwing", () => {
    // @ts-expect-error — runtime guard for unexpected callers.
    assert.equal(isValidLicenseKey(null), false);
    // @ts-expect-error
    assert.equal(isValidLicenseKey(undefined), false);
    // @ts-expect-error
    assert.equal(isValidLicenseKey(12345678901234), false);
  });
});

// ---------------------------------------------------------------------------
// applyLicenseKey + openCheckout — exercise the chrome.* / window.open seams
// behind small fakes so we never actually open a real Stripe Checkout tab.
// ---------------------------------------------------------------------------

type StorageBag = Record<string, unknown>;

function installFakeChrome(opts?: {
  noTabs?: boolean;
  tabsCreateThrows?: boolean;
  noStorage?: boolean;
}): {
  storage: StorageBag;
  tabsCreated: Array<{ url: string }>;
} {
  const storage: StorageBag = {};
  const tabsCreated: Array<{ url: string }> = [];

  const fakeChrome: Record<string, unknown> = {};

  if (!opts?.noStorage) {
    fakeChrome.storage = {
      local: {
        get: async (keys: string | string[] | Record<string, unknown>) => {
          if (typeof keys === "string") {
            return { [keys]: storage[keys] };
          }
          if (Array.isArray(keys)) {
            const out: StorageBag = {};
            for (const k of keys) out[k] = storage[k];
            return out;
          }
          if (keys && typeof keys === "object") {
            const out: StorageBag = {};
            for (const k of Object.keys(keys)) {
              out[k] = storage[k] !== undefined ? storage[k] : (keys as StorageBag)[k];
            }
            return out;
          }
          return { ...storage };
        },
        set: async (patch: StorageBag) => {
          for (const [k, v] of Object.entries(patch)) {
            storage[k] = v;
          }
        },
        remove: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete storage[k];
        },
      },
      onChanged: { addListener: () => {} },
    };
  }

  if (!opts?.noTabs) {
    fakeChrome.tabs = {
      create: async (props: { url: string }) => {
        if (opts?.tabsCreateThrows) throw new Error("denied");
        tabsCreated.push({ url: props.url });
        return { id: tabsCreated.length };
      },
    };
  }

  (globalThis as unknown as { chrome: unknown }).chrome = fakeChrome;
  return { storage, tabsCreated };
}

function uninstallFakeChrome(): void {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

describe("upgrade: openCheckout", () => {
  const originalWindow = (globalThis as unknown as { window?: unknown }).window;

  afterEach(() => {
    uninstallFakeChrome();
    if (originalWindow === undefined) {
      delete (globalThis as unknown as { window?: unknown }).window;
    } else {
      (globalThis as unknown as { window: unknown }).window = originalWindow;
    }
  });

  it("opens via chrome.tabs.create when the API is available", async () => {
    const { tabsCreated } = installFakeChrome();
    const ok = await openCheckout();
    assert.equal(ok, true);
    assert.equal(tabsCreated.length, 1);
    assert.equal(tabsCreated[0].url, buildCheckoutUrl());
  });

  it("forwards installId / locale into the opened URL", async () => {
    const { tabsCreated } = installFakeChrome();
    await openCheckout({ installId: "test123", locale: "ja" });
    assert.equal(tabsCreated.length, 1);
    const parsed = new URL(tabsCreated[0].url);
    assert.equal(parsed.searchParams.get("client_reference_id"), "test123");
    assert.equal(parsed.searchParams.get("locale"), "ja");
  });

  it("falls back to window.open when chrome.tabs.create throws", async () => {
    installFakeChrome({ tabsCreateThrows: true });
    type OpenedCall = { url: string; target: string; features: string };
    const opened: OpenedCall[] = [];
    (globalThis as unknown as { window: unknown }).window = {
      open: (url: string, target?: string, features?: string) => {
        opened.push({ url, target: target ?? "", features: features ?? "" });
        return {};
      },
    };
    const ok = await openCheckout();
    assert.equal(ok, true);
    assert.equal(opened.length, 1, "window.open should have been called once");
    assert.equal(opened[0].url, buildCheckoutUrl());
    assert.equal(opened[0].target, "_blank");
    assert.match(opened[0].features, /noopener/);
  });

  it("falls back to window.open when chrome.tabs is missing", async () => {
    installFakeChrome({ noTabs: true });
    let opened = false;
    (globalThis as unknown as { window: unknown }).window = {
      open: () => {
        opened = true;
        return {};
      },
    };
    const ok = await openCheckout();
    assert.equal(ok, true);
    assert.equal(opened, true);
  });

  it("returns false when neither chrome.tabs nor window.open is available", async () => {
    installFakeChrome({ noTabs: true });
    delete (globalThis as unknown as { window?: unknown }).window;
    const ok = await openCheckout();
    assert.equal(ok, false);
  });
});

describe("upgrade: applyLicenseKey", () => {
  afterEach(() => {
    uninstallFakeChrome();
  });

  it("returns null for malformed input and does not flip the flag", async () => {
    const { storage } = installFakeChrome();
    const result = await applyLicenseKey("not-a-key");
    assert.equal(result, null);
    assert.equal((storage.premium as { premium_unlocked?: boolean } | undefined)?.premium_unlocked, undefined);
  });

  it("flips premium_unlocked=true and returns the updated record on success", async () => {
    const { storage } = installFakeChrome();
    // Seed an existing trial record so patch() merges correctly.
    storage.premium = { trial_start_ts: 1_700_000_000_000, premium_unlocked: false };
    const result = await applyLicenseKey("ABCD-1234-EF56-7890");
    assert.ok(result, "applyLicenseKey should return the updated record");
    assert.equal(result!.premium_unlocked, true);
    assert.equal(result!.trial_start_ts, 1_700_000_000_000);
    assert.equal((storage.premium as { premium_unlocked: boolean }).premium_unlocked, true);
  });

  it("accepts whitespace and lower-case keys (caller pastes from email)", async () => {
    const { storage } = installFakeChrome();
    storage.premium = { trial_start_ts: 0, premium_unlocked: false };
    const result = await applyLicenseKey("  abcd-1234-ef56-7890\n");
    assert.ok(result);
    assert.equal(result!.premium_unlocked, true);
  });
});

// ---------------------------------------------------------------------------
// Static integration: options.html exposes the license UI, options.ts wires
// the buttons to the upgrade module. These are byte-level checks (no DOM
// instantiation) but they prove the wiring lands in the bundle.
// ---------------------------------------------------------------------------

describe("upgrade: options.html exposes license entry", () => {
  const html = readText("src/options.html");

  it("includes the license entry container hidden by default", () => {
    assert.match(html, /id="premium-license"[\s\S]*hidden/);
  });

  it("includes the license key input", () => {
    assert.match(html, /id="opt-license-key"/);
  });

  it("includes the apply-license button", () => {
    assert.match(html, /id="btn-apply-license"/);
  });

  it("includes a license feedback aria-live region", () => {
    assert.match(html, /id="license-feedback"[\s\S]*role="status"[\s\S]*aria-live="polite"/);
  });
});

describe("upgrade: options.ts wires upgrade.ts", () => {
  const optionsTs = readText("src/options.ts");

  it("imports openCheckout and applyLicenseKey from ./upgrade", () => {
    assert.match(optionsTs, /from "\.\/upgrade"/);
    assert.match(optionsTs, /openCheckout/);
    assert.match(optionsTs, /applyLicenseKey/);
  });

  it("invokes openCheckout from the btn-upgrade click handler", () => {
    assert.match(optionsTs, /btnUpgrade\.addEventListener\("click"[\s\S]*openCheckout\(/);
  });

  it("invokes applyLicenseKey from the apply-license handler", () => {
    assert.match(optionsTs, /handleApplyLicense[\s\S]*applyLicenseKey/);
  });

  it("removes the T033 placeholder comment now that the button is wired", () => {
    assert.doesNotMatch(optionsTs, /Stripe Checkout wiring lands in T033/);
  });

  it("hides #premium-license once premium_unlocked is true", () => {
    assert.match(optionsTs, /premiumLicense[\s\S]*hidden = unlocked/);
  });
});
