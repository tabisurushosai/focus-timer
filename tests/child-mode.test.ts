/**
 * Tests for child-mode (T021) — contract/integration checks for the design in
 * docs/design-child-mode.md. The visual side of child-mode is CSS/DOM, so these
 * tests pin the seams that the design depends on:
 *
 *  - the new i18n keys are present in both ja and en locales
 *  - popup.html exposes the confirm <dialog> and aria-live announcer
 *  - popup.css carries the visual presets the design specifies
 *  - DEFAULT_SETTINGS.child_mode defaults to false
 *  - popup.ts gates reset/skip behind confirmAction() when child_mode is on
 *
 * Run with: npm test (uses Node's built-in --test + --experimental-strip-types).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_SETTINGS } from "../src/storage.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function readText(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

function readJson(rel: string): Record<string, { message: string }> {
  return JSON.parse(readText(rel));
}

const CHILD_MODE_KEYS = [
  "popup_child_mode",
  "popup_child_mode_on",
  "popup_child_mode_off",
  "popup_confirm_reset_title",
  "popup_confirm_reset_body",
  "popup_confirm_skip_title",
  "popup_confirm_skip_body",
  "options_child_mode_label",
  "options_child_mode_desc",
  "common_ok",
  "common_cancel",
] as const;

describe("child-mode: i18n keys", () => {
  const ja = readJson("_locales/ja/messages.json");
  const en = readJson("_locales/en/messages.json");

  for (const key of CHILD_MODE_KEYS) {
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

describe("child-mode: default settings", () => {
  it("DEFAULT_SETTINGS.child_mode is false (opt-in)", () => {
    assert.equal(DEFAULT_SETTINGS.child_mode, false);
  });
});

describe("child-mode: popup.html structure", () => {
  const html = readText("src/popup.html");

  it("exposes the child-mode toggle checkbox", () => {
    assert.match(html, /id="toggle-child-mode"/);
  });

  it("includes an aria-live announcer for child-mode state changes", () => {
    assert.match(html, /id="child-mode-announce"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /role="status"/);
  });

  it("includes the confirm <dialog> with title/body wired for aria", () => {
    assert.match(html, /<dialog[^>]*id="confirm-action"/);
    assert.match(html, /aria-labelledby="confirm-title"/);
    assert.match(html, /aria-describedby="confirm-body"/);
    assert.match(html, /id="confirm-title"/);
    assert.match(html, /id="confirm-body"/);
  });

  it("uses i18n keys for OK/Cancel inside the confirm dialog", () => {
    assert.match(html, /data-i18n="common_ok"/);
    assert.match(html, /data-i18n="common_cancel"/);
  });
});

describe("child-mode: popup.css visual presets", () => {
  const css = readText("src/popup.css");

  it("defines a body.child-mode block", () => {
    assert.match(css, /body\.child-mode\s*\{/);
  });

  it("enlarges the timer readout font in child-mode", () => {
    // Design says 42px (vs 36px default).
    assert.match(css, /body\.child-mode\s+\.timer__readout-time\s*\{[^}]*font-size:\s*42px/);
  });

  it("enlarges the button hit target in child-mode", () => {
    // Design says min-height 44px and font-size 16px.
    assert.match(css, /body\.child-mode\s+\.btn\s*\{[^}]*min-height:\s*44px/);
    assert.match(css, /body\.child-mode\s+\.btn\s*\{[^}]*font-size:\s*16px/);
  });

  it("rounds corners more in child-mode (--radius-md: 14px)", () => {
    assert.match(css, /body\.child-mode\s*\{[^}]*--radius-md:\s*14px/);
  });

  it("thickens the focus ring in child-mode", () => {
    assert.match(css, /body\.child-mode\s+:focus-visible\s*\{[^}]*outline-width:\s*3px/);
  });

  it("applies the soft pink/green/purple progress colors per phase", () => {
    assert.match(css, /body\.child-mode\.mode-work\s*\{[^}]*--color-progress:\s*#ff7ab6/i);
    assert.match(css, /body\.child-mode\.mode-break\s*\{[^}]*--color-progress:\s*#4cc88a/i);
    assert.match(
      css,
      /body\.child-mode\.mode-long-break\s*\{[^}]*--color-progress:\s*#c084fc/i,
    );
  });

  it("honors prefers-reduced-motion by disabling the progress transition", () => {
    assert.match(
      css,
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.timer__progress[\s\S]*?transition:\s*none/,
    );
  });

  it("strengthens contrast under prefers-contrast: more", () => {
    assert.match(css, /@media\s*\(prefers-contrast:\s*more\)\s*\{[\s\S]*?body\.child-mode/);
  });
});

describe("child-mode: popup.ts destructive-action gating", () => {
  const src = readText("src/popup.ts");

  it("defines isChildMode() based on the body class", () => {
    assert.match(src, /classList\.contains\("child-mode"\)/);
  });

  it("gates handleReset behind confirmAction with the reset i18n keys", () => {
    assert.match(
      src,
      /handleReset[\s\S]*?confirmAction\(\s*"popup_confirm_reset_title"\s*,\s*"popup_confirm_reset_body"\s*\)/,
    );
  });

  it("gates handleSkip behind confirmAction with the skip i18n keys", () => {
    assert.match(
      src,
      /handleSkip[\s\S]*?confirmAction\(\s*"popup_confirm_skip_title"\s*,\s*"popup_confirm_skip_body"\s*\)/,
    );
  });

  it("only invokes the dialog when child-mode is active", () => {
    // Both handlers must check isChildMode() before showing the dialog —
    // otherwise normal mode would also be prompted, which the design forbids.
    const reset = /async function handleReset\([\s\S]*?\}\s*\n/.exec(src)?.[0] ?? "";
    const skip = /async function handleSkip\([\s\S]*?\}\s*\n/.exec(src)?.[0] ?? "";
    assert.ok(reset.length > 0, "handleReset block not found");
    assert.ok(skip.length > 0, "handleSkip block not found");
    assert.match(reset, /isChildMode\(\)/);
    assert.match(skip, /isChildMode\(\)/);
  });

  it("persists child_mode through patchSettings on toggle change", () => {
    assert.match(
      src,
      /toggleChildMode\.addEventListener\("change"[\s\S]*?patchSettings\(\{\s*child_mode:/,
    );
  });

  it("applies the child-mode body class from settings", () => {
    assert.match(src, /classList\.toggle\("child-mode",\s*settings\.child_mode\)/);
  });
});
