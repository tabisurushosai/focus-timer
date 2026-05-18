/**
 * Tests for premium (T110) — pure predicates from src/premium.ts.
 *
 * The async helpers (getPremium / ensureTrialStarted / unlockPremium /
 * lockPremium) touch chrome.storage.local and are already exercised via the
 * upgrade.test.ts seam through applyLicenseKey → unlockPremium. This file
 * pins only the pure logic so it can run under Node's built-in --test runner
 * without faking chrome.*:
 *
 *  - isPremium: literal flag check
 *  - isTrial: window-elapsed arithmetic, unlocked short-circuit, missing
 *    timestamp guard
 *  - hasPremiumAccess: OR of the two predicates
 *  - trialDaysLeft: ceil() with [0, TRIAL_DAYS] clamp
 *  - premiumTier: three-way classifier
 *
 * Run with: npm test (uses Node's built-in --test + --experimental-strip-types).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  TRIAL_DAYS,
  hasPremiumAccess,
  isPremium,
  isTrial,
  premiumTier,
  trialDaysLeft,
} from "../src/premium.ts";
import type { Premium } from "../src/storage.ts";

const DAY_MS = 86_400_000;
const NOW = new Date(2026, 4, 18, 12, 0, 0).getTime();

function premium(overrides: Partial<Premium> = {}): Premium {
  return { trial_start_ts: 0, premium_unlocked: false, ...overrides };
}

describe("premium: isPremium", () => {
  it("returns true only when premium_unlocked is literally true", () => {
    assert.equal(isPremium(premium({ premium_unlocked: true })), true);
    assert.equal(isPremium(premium({ premium_unlocked: false })), false);
  });

  it("does not consider trial_start_ts (trial users are not premium)", () => {
    const trialing = premium({ trial_start_ts: NOW - DAY_MS, premium_unlocked: false });
    assert.equal(isPremium(trialing), false);
  });
});

describe("premium: isTrial", () => {
  it("is true within the TRIAL_DAYS window", () => {
    const started = premium({ trial_start_ts: NOW - 2 * DAY_MS });
    assert.equal(isTrial(started, NOW), true);
  });

  it("is false once TRIAL_DAYS has elapsed", () => {
    const expired = premium({ trial_start_ts: NOW - TRIAL_DAYS * DAY_MS - 1 });
    assert.equal(isTrial(expired, NOW), false);
  });

  it("is false when premium_unlocked is true (paid takes precedence over trial)", () => {
    const paid = premium({
      trial_start_ts: NOW - DAY_MS,
      premium_unlocked: true,
    });
    assert.equal(isTrial(paid, NOW), false);
  });

  it("is false when trial_start_ts is missing (0) — caller must bootstrap", () => {
    assert.equal(isTrial(premium({ trial_start_ts: 0 }), NOW), false);
  });
});

describe("premium: hasPremiumAccess", () => {
  it("is true for paid users regardless of timestamp", () => {
    const paid = premium({ trial_start_ts: 0, premium_unlocked: true });
    assert.equal(hasPremiumAccess(paid, NOW), true);
  });

  it("is true for users still inside the trial window", () => {
    const trialing = premium({ trial_start_ts: NOW - DAY_MS });
    assert.equal(hasPremiumAccess(trialing, NOW), true);
  });

  it("is false for free users whose trial has lapsed", () => {
    const lapsed = premium({ trial_start_ts: NOW - (TRIAL_DAYS + 1) * DAY_MS });
    assert.equal(hasPremiumAccess(lapsed, NOW), false);
  });
});

describe("premium: trialDaysLeft", () => {
  it("returns 0 when the user has already paid (no trial countdown shown)", () => {
    const paid = premium({ trial_start_ts: NOW - DAY_MS, premium_unlocked: true });
    assert.equal(trialDaysLeft(paid, NOW), 0);
  });

  it("returns 0 when trial_start_ts is missing", () => {
    assert.equal(trialDaysLeft(premium({ trial_start_ts: 0 }), NOW), 0);
  });

  it("returns TRIAL_DAYS at trial start (rounded up)", () => {
    const fresh = premium({ trial_start_ts: NOW });
    assert.equal(trialDaysLeft(fresh, NOW), TRIAL_DAYS);
  });

  it("ceils partial days so '6 days and 1 hour left' reads as 7", () => {
    const trialing = premium({
      trial_start_ts: NOW - (DAY_MS - 60 * 60 * 1_000),
    });
    assert.equal(trialDaysLeft(trialing, NOW), TRIAL_DAYS);
  });

  it("clamps to 0 once the trial has expired (never negative)", () => {
    const expired = premium({ trial_start_ts: NOW - (TRIAL_DAYS + 5) * DAY_MS });
    assert.equal(trialDaysLeft(expired, NOW), 0);
  });
});

describe("premium: premiumTier", () => {
  it("returns 'premium' when the unlock flag is set", () => {
    assert.equal(premiumTier(premium({ premium_unlocked: true }), NOW), "premium");
  });

  it("returns 'trial' for an active trial window", () => {
    const trialing = premium({ trial_start_ts: NOW - 3 * DAY_MS });
    assert.equal(premiumTier(trialing, NOW), "trial");
  });

  it("returns 'free' for an expired trial without an unlock", () => {
    const lapsed = premium({ trial_start_ts: NOW - (TRIAL_DAYS + 1) * DAY_MS });
    assert.equal(premiumTier(lapsed, NOW), "free");
  });

  it("returns 'free' when trial_start_ts is missing (pre-bootstrap state)", () => {
    assert.equal(premiumTier(premium({ trial_start_ts: 0 }), NOW), "free");
  });
});
