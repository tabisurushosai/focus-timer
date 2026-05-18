#!/usr/bin/env node
// Audit _locales/* against src usage and cross-locale parity.
// Fails with non-zero exit when any key is unused or any locale diverges
// (missing keys, placeholder set differences, or $TOKEN$ mismatches in messages).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const BASE_LOCALE = "en";
const LOCALES_DIR = resolve(root, "_locales");
const USAGE_ROOTS = ["src", "scripts", "tests", "docs"];
const USAGE_FILES = ["manifest.json"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

const loadLocale = (locale) => {
  const path = join(LOCALES_DIR, locale, "messages.json");
  return JSON.parse(readFileSync(path, "utf8"));
};

const collectFiles = () => {
  const out = [];
  for (const f of USAGE_FILES) {
    const p = resolve(root, f);
    try { statSync(p); out.push(p); } catch {}
  }
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (e.isFile()) {
        out.push(join(dir, e.name));
      }
    }
  };
  for (const d of USAGE_ROOTS) walk(resolve(root, d));
  return out;
};

const readAllUsage = () => collectFiles().map((p) => readFileSync(p, "utf8")).join("\n");

const placeholderTokens = (msg) => {
  const set = new Set();
  for (const m of msg.matchAll(/\$([A-Za-z0-9_]+)\$/g)) set.add(m[1].toLowerCase());
  return set;
};

const setsEqual = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

const base = loadLocale(BASE_LOCALE);
const baseKeys = Object.keys(base);
const usage = readAllUsage();

const errors = [];

for (const key of baseKeys) {
  const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`);
  if (!re.test(usage)) errors.push(`unused: ${key}`);
}

const locales = readdirSync(LOCALES_DIR).filter((n) => {
  try { return statSync(join(LOCALES_DIR, n)).isDirectory(); } catch { return false; }
});

for (const locale of locales) {
  if (locale === BASE_LOCALE) continue;
  const data = loadLocale(locale);
  const otherKeys = new Set(Object.keys(data));
  for (const k of baseKeys) {
    if (!otherKeys.has(k)) { errors.push(`${locale}: missing key '${k}'`); continue; }
    const e = base[k];
    const o = data[k];
    const ePh = new Set(Object.keys(e.placeholders || {}));
    const oPh = new Set(Object.keys(o.placeholders || {}));
    if (!setsEqual(ePh, oPh)) errors.push(`${locale}: placeholder set mismatch on '${k}'`);
    if (!setsEqual(placeholderTokens(e.message || ""), placeholderTokens(o.message || ""))) {
      errors.push(`${locale}: $TOKEN$ mismatch in message for '${k}'`);
    }
  }
  for (const k of otherKeys) {
    if (!(k in base)) errors.push(`${locale}: extra key '${k}' not present in ${BASE_LOCALE}`);
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`[check-i18n] ${e}`);
  console.error(`[check-i18n] ${errors.length} issue(s) found`);
  process.exit(1);
}

console.log(`[check-i18n] OK: ${baseKeys.length} keys, ${locales.length} locale(s), all in use, all consistent`);
