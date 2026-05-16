/**
 * storage.ts — typed wrapper around chrome.storage.local.
 *
 * Single source of truth for the four top-level keys used by the extension
 * (settings, timer, stats, premium). All persisted state flows through here so
 * the popup, options page, and service worker stay in sync without duplicating
 * the schema. Kept dependency-free so it can be imported from any bundle,
 * including the service worker.
 */

export type TimerMode = "work" | "break" | "long_break";
export type Theme = "light" | "dark" | "system";
export type Language = "ja" | "en" | "auto";

export type TimerState = {
  mode: TimerMode;
  running: boolean;
  /** Epoch ms when the current phase should end. 0 when not running. */
  end_ts: number;
  /** Remaining ms captured at pause; used to resume without drift. */
  remaining_ms: number;
  /** Number of completed work sessions since the last long break. */
  session_count: number;
};

export type Settings = {
  work_min: number;
  break_min: number;
  long_break_min: number;
  sessions_until_long_break: number;
  auto_start_break: boolean;
  auto_start_work: boolean;
  theme: Theme;
  sound_enabled: boolean;
  sound_volume: number;
  notification_enabled: boolean;
  break_reminder_enabled: boolean;
  child_mode: boolean;
  language: Language;
};

export type DailyStat = { focus_min: number; sessions: number };

export type Stats = {
  /** Map of YYYY-MM-DD → daily totals. */
  daily: Record<string, DailyStat>;
  total_focus_min: number;
  total_sessions: number;
};

export type Premium = {
  trial_start_ts: number;
  premium_unlocked: boolean;
};

export type StorageShape = {
  settings: Settings;
  timer: TimerState;
  stats: Stats;
  premium: Premium;
};

export type StorageKey = keyof StorageShape;

export const TRIAL_DAYS = 7;

export const DEFAULT_SETTINGS: Settings = {
  work_min: 25,
  break_min: 5,
  long_break_min: 15,
  sessions_until_long_break: 4,
  auto_start_break: false,
  auto_start_work: false,
  theme: "system",
  sound_enabled: true,
  sound_volume: 0.6,
  notification_enabled: true,
  break_reminder_enabled: true,
  child_mode: false,
  language: "auto",
};

export const DEFAULT_TIMER: TimerState = {
  mode: "work",
  running: false,
  end_ts: 0,
  remaining_ms: DEFAULT_SETTINGS.work_min * 60_000,
  session_count: 0,
};

export const DEFAULT_STATS: Stats = {
  daily: {},
  total_focus_min: 0,
  total_sessions: 0,
};

export function createDefaultPremium(now: number = Date.now()): Premium {
  return { trial_start_ts: now, premium_unlocked: false };
}

export function getDefault<K extends StorageKey>(key: K): StorageShape[K] {
  switch (key) {
    case "settings":
      return DEFAULT_SETTINGS as StorageShape[K];
    case "timer":
      return DEFAULT_TIMER as StorageShape[K];
    case "stats":
      return DEFAULT_STATS as StorageShape[K];
    case "premium":
      return createDefaultPremium() as StorageShape[K];
    default: {
      const exhaustive: never = key;
      throw new Error(`unknown storage key: ${String(exhaustive)}`);
    }
  }
}

/**
 * Read a single key, falling back to the default if absent. The default is
 * shallow-merged for object-shaped keys so newly added fields populate without
 * a migration step.
 */
export async function get<K extends StorageKey>(key: K): Promise<StorageShape[K]> {
  const raw = (await chrome.storage.local.get(key)) as Partial<StorageShape>;
  const stored = raw[key];
  const fallback = getDefault(key);
  if (stored === undefined || stored === null) return fallback;
  if (typeof fallback === "object" && fallback !== null && typeof stored === "object") {
    return { ...fallback, ...(stored as object) } as StorageShape[K];
  }
  return stored as StorageShape[K];
}

/** Read multiple keys at once. Each missing key is filled with its default. */
export async function getMany<K extends StorageKey>(
  keys: readonly K[],
): Promise<{ [P in K]: StorageShape[P] }> {
  const raw = (await chrome.storage.local.get(keys as unknown as string[])) as Partial<StorageShape>;
  const out = {} as { [P in K]: StorageShape[P] };
  for (const key of keys) {
    const stored = raw[key];
    const fallback = getDefault(key);
    if (stored === undefined || stored === null) {
      out[key] = fallback;
    } else if (
      typeof fallback === "object" &&
      fallback !== null &&
      typeof stored === "object"
    ) {
      out[key] = { ...fallback, ...(stored as object) } as StorageShape[K];
    } else {
      out[key] = stored as StorageShape[K];
    }
  }
  return out;
}

/** Overwrite a single key. */
export async function set<K extends StorageKey>(
  key: K,
  value: StorageShape[K],
): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

/** Shallow-merge a partial patch into the stored value. */
export async function patch<K extends StorageKey>(
  key: K,
  partial: Partial<StorageShape[K]>,
): Promise<StorageShape[K]> {
  const current = await get(key);
  const next = { ...(current as object), ...(partial as object) } as StorageShape[K];
  await set(key, next);
  return next;
}

/** Remove keys entirely. Subsequent reads will return defaults. */
export async function remove(keys: StorageKey | readonly StorageKey[]): Promise<void> {
  await chrome.storage.local.remove(keys as unknown as string | string[]);
}

/**
 * Populate any missing top-level keys with their defaults. Safe to call on
 * every install/startup — existing values are left untouched.
 */
export async function ensureDefaults(): Promise<void> {
  const raw = (await chrome.storage.local.get([
    "settings",
    "timer",
    "stats",
    "premium",
  ])) as Partial<StorageShape>;
  const patchObj: Partial<StorageShape> = {};
  if (!raw.settings) patchObj.settings = DEFAULT_SETTINGS;
  if (!raw.timer) patchObj.timer = DEFAULT_TIMER;
  if (!raw.stats) patchObj.stats = DEFAULT_STATS;
  if (!raw.premium) patchObj.premium = createDefaultPremium();
  if (Object.keys(patchObj).length > 0) {
    await chrome.storage.local.set(patchObj);
  }
}

export type StorageChange<K extends StorageKey> = {
  key: K;
  oldValue: StorageShape[K] | undefined;
  newValue: StorageShape[K] | undefined;
};

export type StorageWatchHandler = (changes: {
  [K in StorageKey]?: StorageChange<K>;
}) => void;

/**
 * Subscribe to changes on any of the typed keys. Returns an unsubscribe fn.
 * Only `local`-area changes are forwarded.
 */
export function watch(handler: StorageWatchHandler): () => void {
  const TRACKED: readonly StorageKey[] = ["settings", "timer", "stats", "premium"];
  const listener = (
    rawChanges: { [key: string]: chrome.storage.StorageChange },
    area: chrome.storage.AreaName,
  ): void => {
    if (area !== "local") return;
    const out: { [K in StorageKey]?: StorageChange<K> } = {};
    let touched = false;
    for (const key of TRACKED) {
      if (key in rawChanges) {
        const change = rawChanges[key];
        (out as Record<StorageKey, StorageChange<StorageKey>>)[key] = {
          key,
          oldValue: change.oldValue as StorageShape[typeof key] | undefined,
          newValue: change.newValue as StorageShape[typeof key] | undefined,
        };
        touched = true;
      }
    }
    if (touched) handler(out);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** True while the unlock flag is false and the trial window has not elapsed. */
export function isInTrial(premium: Premium, now: number = Date.now()): boolean {
  if (premium.premium_unlocked) return false;
  if (!premium.trial_start_ts) return false;
  const elapsedDays = (now - premium.trial_start_ts) / 86_400_000;
  return elapsedDays < TRIAL_DAYS;
}

/** True if Premium features should be available (unlocked or in trial). */
export function hasPremiumAccess(premium: Premium, now: number = Date.now()): boolean {
  return premium.premium_unlocked || isInTrial(premium, now);
}

/** Whole minutes left in the trial, clamped to [0, TRIAL_DAYS]. */
export function trialDaysLeft(premium: Premium, now: number = Date.now()): number {
  if (premium.premium_unlocked || !premium.trial_start_ts) return 0;
  const elapsedDays = (now - premium.trial_start_ts) / 86_400_000;
  return Math.max(0, Math.ceil(TRIAL_DAYS - elapsedDays));
}
