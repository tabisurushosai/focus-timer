/**
 * Tests for sound-mute (T027) — contract/integration checks for the design in
 * docs/design-sound-mute.md. Audio playback itself runs in an offscreen
 * document and can't be exercised under Node, so these tests pin the seams
 * that the design depends on:
 *
 *  - sound.ts pure helpers (isSoundActive, effectiveVolume, clampVolumeForMode)
 *    and the playPhaseTransition no-op / debounce contract
 *  - i18n keys present in both ja and en locales
 *  - manifest.json carries the "offscreen" permission
 *  - background.ts triggers playPhaseTransition on phase-end AND skip,
 *    and does NOT trigger it from reset()
 *  - popup.html exposes the sound-announce aria-live region and #toggle-mute
 *  - popup.ts wires the toggle to patchSettings({ sound_enabled: !checked })
 *    and announces via popup_sound_on / popup_sound_off
 *  - options.html exposes the test button, child hint, and sound section
 *  - options.ts clamps volume per child-mode on save and wires the test button
 *
 * Run with: npm test (uses Node's built-in --test + --experimental-strip-types).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  CHILD_VOLUME_CAP,
  DEBOUNCE_MS,
  FALLBACK_VOLUME,
  _resetDebounceForTests,
  clampVolumeForMode,
  effectiveVolume,
  isSoundActive,
  playPhaseTransition,
} from "../src/sound.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/storage.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function readText(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

function readJson(rel: string): Record<string, { message: string }> {
  return JSON.parse(readText(rel));
}

const SOUND_I18N_KEYS = [
  "popup_mute",
  "popup_unmute",
  "popup_sound_on",
  "popup_sound_off",
  "options_section_sound",
  "options_sound_enabled",
  "options_sound_volume",
  "options_sound_hint",
  "options_sound_test",
  "options_sound_volume_child_hint",
] as const;

describe("sound-mute: i18n keys", () => {
  const ja = readJson("_locales/ja/messages.json");
  const en = readJson("_locales/en/messages.json");

  for (const key of SOUND_I18N_KEYS) {
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

describe("sound-mute: manifest", () => {
  it("declares the offscreen permission", () => {
    const manifest = JSON.parse(readText("manifest.json")) as {
      permissions?: string[];
    };
    assert.ok(
      Array.isArray(manifest.permissions),
      "manifest has no permissions array",
    );
    assert.ok(
      manifest.permissions.includes("offscreen"),
      "manifest does not include offscreen permission",
    );
  });
});

describe("sound-mute: storage defaults", () => {
  it("sound_enabled defaults true (audio on out of the box)", () => {
    assert.equal(DEFAULT_SETTINGS.sound_enabled, true);
  });
  it("sound_volume defaults to 0.6 (matches design)", () => {
    assert.equal(DEFAULT_SETTINGS.sound_volume, 0.6);
  });
});

function withSettings(overrides: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("sound.ts: isSoundActive", () => {
  it("requires both sound_enabled and a positive volume", () => {
    assert.equal(isSoundActive(withSettings({ sound_enabled: true, sound_volume: 0.6 })), true);
    assert.equal(isSoundActive(withSettings({ sound_enabled: false, sound_volume: 0.6 })), false);
    assert.equal(isSoundActive(withSettings({ sound_enabled: true, sound_volume: 0 })), false);
    assert.equal(isSoundActive(withSettings({ sound_enabled: false, sound_volume: 0 })), false);
  });
});

describe("sound.ts: clampVolumeForMode / effectiveVolume", () => {
  it("clamps to [0,1] for arbitrary input", () => {
    assert.equal(clampVolumeForMode(-0.5, false), 0);
    assert.equal(clampVolumeForMode(2, false), 1);
    assert.equal(clampVolumeForMode(0.5, false), 0.5);
  });

  it("returns FALLBACK_VOLUME for non-finite input", () => {
    assert.equal(clampVolumeForMode(Number.NaN, false), FALLBACK_VOLUME);
    assert.equal(clampVolumeForMode(Number.POSITIVE_INFINITY, true), FALLBACK_VOLUME);
  });

  it("caps at CHILD_VOLUME_CAP (0.8) when child mode is on", () => {
    assert.equal(clampVolumeForMode(1, true), CHILD_VOLUME_CAP);
    assert.equal(clampVolumeForMode(0.9, true), CHILD_VOLUME_CAP);
    assert.equal(clampVolumeForMode(0.5, true), 0.5);
  });

  it("effectiveVolume composes the storage volume with the child cap", () => {
    assert.equal(
      effectiveVolume(withSettings({ sound_volume: 1, child_mode: true })),
      CHILD_VOLUME_CAP,
    );
    assert.equal(
      effectiveVolume(withSettings({ sound_volume: 0.4, child_mode: true })),
      0.4,
    );
    assert.equal(
      effectiveVolume(withSettings({ sound_volume: 1, child_mode: false })),
      1,
    );
  });
});

describe("sound.ts: playPhaseTransition (no-op contract)", () => {
  // Build a minimal chrome global so the function can run under Node without
  // touching the real offscreen API. We assert the SEAMS — "did it try to
  // create an offscreen document" and "did it send a sound_play message" —
  // rather than actual audio output, which is browser-only.
  type Calls = { create: number; send: number; lastVolume?: number };

  function installFakeChrome(): Calls {
    const calls: Calls = { create: 0, send: 0 };
    (globalThis as unknown as { chrome: unknown }).chrome = {
      offscreen: {
        hasDocument: async () => false,
        createDocument: async () => {
          calls.create += 1;
        },
      },
      runtime: {
        sendMessage: async (msg: { type: string; volume: number }) => {
          if (msg && msg.type === "sound_play") {
            calls.send += 1;
            calls.lastVolume = msg.volume;
          }
        },
      },
    };
    return calls;
  }

  function uninstallFakeChrome(): void {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  }

  beforeEach(() => {
    _resetDebounceForTests();
  });
  afterEach(() => {
    uninstallFakeChrome();
  });

  it("no-ops when sound_enabled is false (does not create offscreen doc)", async () => {
    const calls = installFakeChrome();
    await playPhaseTransition(
      "work",
      withSettings({ sound_enabled: false, sound_volume: 0.6 }),
      1_000,
    );
    assert.equal(calls.create, 0);
    assert.equal(calls.send, 0);
  });

  it("no-ops when sound_volume is 0 (does not create offscreen doc)", async () => {
    const calls = installFakeChrome();
    await playPhaseTransition(
      "work",
      withSettings({ sound_enabled: true, sound_volume: 0 }),
      1_000,
    );
    assert.equal(calls.create, 0);
    assert.equal(calls.send, 0);
  });

  it("creates offscreen doc and posts sound_play when active", async () => {
    const calls = installFakeChrome();
    await playPhaseTransition("break", withSettings({}), 1_000);
    assert.equal(calls.create, 1);
    assert.equal(calls.send, 1);
    assert.equal(calls.lastVolume, 0.6);
  });

  it("passes the child-capped volume through to sound_play", async () => {
    const calls = installFakeChrome();
    await playPhaseTransition(
      "work",
      withSettings({ sound_volume: 1, child_mode: true }),
      1_000,
    );
    assert.equal(calls.send, 1);
    assert.equal(calls.lastVolume, CHILD_VOLUME_CAP);
  });

  it("debounces rapid calls within DEBOUNCE_MS", async () => {
    const calls = installFakeChrome();
    await playPhaseTransition("work", withSettings({}), 1_000);
    await playPhaseTransition("work", withSettings({}), 1_000 + Math.floor(DEBOUNCE_MS / 2));
    assert.equal(calls.send, 1, "second call within debounce window must be suppressed");
  });

  it("plays again once DEBOUNCE_MS has elapsed", async () => {
    const calls = installFakeChrome();
    await playPhaseTransition("work", withSettings({}), 1_000);
    await playPhaseTransition("work", withSettings({}), 1_000 + DEBOUNCE_MS + 1);
    assert.equal(calls.send, 2);
  });

  it("no-ops gracefully when chrome.offscreen is unavailable", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage: async () => {} },
      // offscreen intentionally omitted — simulate older Chrome
    };
    await playPhaseTransition("work", withSettings({}), 1_000);
    // No throw is the contract; absence of chrome.offscreen must not surface.
    assert.ok(true);
  });
});

describe("sound-mute: popup wiring", () => {
  const html = readText("src/popup.html");
  const src = readText("src/popup.ts");

  it("popup.html exposes #toggle-mute checkbox", () => {
    assert.match(html, /id="toggle-mute"/);
  });

  it("popup.html exposes #sound-announce aria-live region", () => {
    assert.match(html, /id="sound-announce"/);
    // The element must be polite, role=status, and visually-hidden so SR users
    // hear the state change without sighted users seeing a banner.
    assert.match(
      html,
      /id="sound-announce"[\s\S]*?aria-live="polite"[\s\S]*?role="status"|id="sound-announce"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/,
    );
  });

  it("popup.ts patches sound_enabled = !checked on toggle change", () => {
    // ON = mute (so sound_enabled = !target.checked) — matches the design's
    // popup label convention.
    assert.match(
      src,
      /toggleMute\.addEventListener\("change"[\s\S]*?patchSettings\(\{\s*sound_enabled:\s*!els\.toggleMute\.checked/,
    );
  });

  it("popup.ts uses popup_sound_on / popup_sound_off for announcement", () => {
    assert.match(src, /popup_sound_on/);
    assert.match(src, /popup_sound_off/);
  });

  it("popup.ts toggles body.is-muted to mirror sound_enabled", () => {
    assert.match(
      src,
      /classList\.toggle\("is-muted",\s*!settings\.sound_enabled\)/,
    );
  });
});

describe("sound-mute: background wiring", () => {
  const src = readText("src/background.ts");

  it("imports playPhaseTransition from ./sound", () => {
    assert.match(src, /import\s*\{\s*playPhaseTransition\s*\}\s*from\s*"\.\/sound"/);
  });

  it("calls playPhaseTransition inside handlePhaseEnd", () => {
    const block = /async function handlePhaseEnd\([\s\S]*?\n\}\n/.exec(src)?.[0] ?? "";
    assert.ok(block.length > 0, "handlePhaseEnd block not found");
    assert.match(block, /playPhaseTransition\(\s*next\s*,\s*settings\s*\)/);
  });

  it("calls playPhaseTransition inside skip()", () => {
    const block = /async function skip\([\s\S]*?\n\}\n/.exec(src)?.[0] ?? "";
    assert.ok(block.length > 0, "skip block not found");
    assert.match(block, /playPhaseTransition\(\s*next\s*,\s*settings\s*\)/);
  });

  it("does NOT call playPhaseTransition inside reset()", () => {
    // reset() being silent is in the design's acceptance criteria. Pin it so a
    // future refactor doesn't accidentally start nagging the user.
    const block = /async function reset\([\s\S]*?\n\}\n/.exec(src)?.[0] ?? "";
    assert.ok(block.length > 0, "reset block not found");
    assert.doesNotMatch(block, /playPhaseTransition/);
  });

  it("background no longer surfaces invalid_message for unknown traffic", () => {
    // Without this opt-out the offscreen 'sound_play' round-trip would race
    // background's sendResponse and tear down the channel.
    assert.doesNotMatch(src, /invalid_message/);
  });
});

describe("sound-mute: options wiring", () => {
  const html = readText("src/options.html");
  const src = readText("src/options.ts");

  it("options.html still has a Sound section heading", () => {
    assert.match(html, /id="sec-sound-heading"/);
  });

  it("options.html exposes #btn-sound-test", () => {
    assert.match(html, /id="btn-sound-test"/);
    assert.match(html, /data-i18n="options_sound_test"/);
  });

  it("options.html exposes the child-mode volume hint (hidden by default)", () => {
    assert.match(html, /id="opt-sound-volume-child-hint"/);
    assert.match(html, /data-i18n="options_sound_volume_child_hint"/);
    // hidden attribute must be present so non-child-mode users don't see it.
    assert.match(
      html,
      /id="opt-sound-volume-child-hint"[\s\S]*?hidden|hidden[\s\S]*?id="opt-sound-volume-child-hint"/,
    );
  });

  it("options.html surfaces the always-visible sound hint", () => {
    assert.match(html, /data-i18n="options_sound_hint"/);
  });

  it("options.ts imports clampVolumeForMode and playPhaseTransition from ./sound", () => {
    assert.match(
      src,
      /import\s*\{\s*clampVolumeForMode,\s*playPhaseTransition\s*\}\s*from\s*"\.\/sound"/,
    );
  });

  it("options.ts clamps volume per child-mode in readForm() before saving", () => {
    // The cap must be applied on the write side so it survives a child-mode
    // toggle later. Live preview is separate.
    const block = /function readForm\(\)[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    assert.ok(block.length > 0, "readForm block not found");
    assert.match(block, /clampVolumeForMode\(/);
  });

  it("options.ts disables the volume slider when sound is off", () => {
    assert.match(src, /els\.soundVolume\.disabled\s*=\s*!settings\.sound_enabled/);
  });

  it("options.ts wires the test-sound button to playPhaseTransition", () => {
    assert.match(
      src,
      /btnSoundTest[\s\S]*?addEventListener\("click"[\s\S]*?playPhaseTransition\(/,
    );
  });
});

describe("sound-mute: offscreen surface", () => {
  it("src/offscreen.html exists and loads ./offscreen.ts as a module", () => {
    const html = readText("src/offscreen.html");
    assert.match(html, /<script[^>]*type="module"[^>]*src="\.\/offscreen\.ts"/);
  });

  it("src/offscreen.ts listens for sound_play messages", () => {
    const src = readText("src/offscreen.ts");
    assert.match(src, /chrome\.runtime\.onMessage\.addListener/);
    assert.match(src, /sound_play/);
    // Plays via AudioContext (so no asset shipping needed).
    assert.match(src, /AudioContext/);
  });

  it("vite.config.ts builds offscreen.html as a separate entry", () => {
    const cfg = readText("vite.config.ts");
    assert.match(cfg, /offscreen:\s*resolve\(__dirname,\s*'src\/offscreen\.html'\)/);
  });
});
