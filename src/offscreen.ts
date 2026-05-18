/**
 * offscreen.ts — runs inside the MV3 offscreen document so we can use
 * AudioContext (forbidden in the service worker). Listens for `sound_play`
 * messages from background and synthesises a short sine chime with a soft
 * attack/decay envelope.
 *
 * Design: docs/design-sound-mute.md.
 */

type SoundPlayMessage = {
  type: "sound_play";
  volume: number;
};

const CHIME_FREQ_HZ = 880;
const ATTACK_S = 0.02;
const HOLD_S = 0.08;
const DECAY_S = 0.32;
const TOTAL_S = ATTACK_S + HOLD_S + DECAY_S;

let audioCtx: AudioContext | null = null;

/** Lazily create (and reuse) the single AudioContext for this document. */
function context(): AudioContext {
  if (!audioCtx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    audioCtx = new Ctor();
  }
  return audioCtx;
}

/** Coerce arbitrary input into a safe [0,1] gain value. NaN/garbage → 0 (silent). */
function clampVolume(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Emit a short sine chime with attack/hold/exponential-decay envelope. The
 * exponential tail avoids the click an abrupt cut would produce on speakers.
 */
function playChime(volume: number): void {
  if (volume <= 0) return;
  const ctx = context();
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = CHIME_FREQ_HZ;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(gain).connect(ctx.destination);
  const start = ctx.currentTime;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + ATTACK_S);
  gain.gain.setValueAtTime(volume, start + ATTACK_S + HOLD_S);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + TOTAL_S);
  osc.start(start);
  osc.stop(start + TOTAL_S + 0.02);
}

/** Type guard for incoming sound_play envelopes from background.ts. */
function isSoundPlay(msg: unknown): msg is SoundPlayMessage {
  return (
    !!msg &&
    typeof msg === "object" &&
    (msg as { type?: unknown }).type === "sound_play"
  );
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!isSoundPlay(msg)) return false;
  try {
    playChime(clampVolume(msg.volume));
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  return false;
});
