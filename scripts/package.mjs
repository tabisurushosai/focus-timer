#!/usr/bin/env node
// Bundle dist/ + manifest.json + icons/ + _locales/ + legal/ into release/focus-timer.zip
// Layout matches manifest paths: background.js at root, src/*.html under src/,
// hashed assets under assets/, locales under _locales/, icons under icons/,
// and legal docs under legal/ for options-page links.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = resolve(root, "dist");
const release = resolve(root, "release");
const staging = resolve(release, "staging");
const zipPath = resolve(release, "focus-timer.zip");

const requireExists = (path, hint) => {
  if (!existsSync(path)) {
    console.error(`[package] missing ${hint}: ${path}`);
    console.error(`[package] run 'npm run build' first`);
    process.exit(1);
  }
};

requireExists(resolve(root, "manifest.json"), "manifest.json");
requireExists(resolve(root, "icons"), "icons/");
requireExists(resolve(root, "_locales"), "_locales/");
requireExists(resolve(root, "legal"), "legal/");
requireExists(dist, "dist/");
requireExists(resolve(dist, "background.js"), "dist/background.js");

if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
if (existsSync(zipPath)) rmSync(zipPath, { force: true });
mkdirSync(staging, { recursive: true });

cpSync(resolve(root, "manifest.json"), resolve(staging, "manifest.json"));
cpSync(resolve(root, "icons"), resolve(staging, "icons"), { recursive: true });
cpSync(resolve(root, "_locales"), resolve(staging, "_locales"), { recursive: true });
cpSync(resolve(root, "legal"), resolve(staging, "legal"), { recursive: true });
cpSync(dist, staging, { recursive: true });

const result = spawnSync(
  "zip",
  ["-r", "-X", zipPath, "manifest.json", "icons", "_locales", "legal", "background.js", "src", "assets"],
  { cwd: staging, stdio: "inherit" },
);

if (result.status !== 0) {
  console.error(`[package] zip failed with status ${result.status}`);
  process.exit(result.status ?? 1);
}

rmSync(staging, { recursive: true, force: true });

const { size } = statSync(zipPath);
const kb = (size / 1024).toFixed(1);
console.log(`[package] wrote ${zipPath} (${kb} KB)`);
