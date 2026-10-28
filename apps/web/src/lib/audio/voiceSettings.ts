/**
 * Microphone clean-up: what the user chose and what this device can run.
 * Pure (unit-tested); the audio graph itself is lib/audio/voiceProcessor.ts.
 *
 * Measured on 24 s of speech mixed with real and synthetic noise
 * (docs/AUDIO.md): RNNoise removes fans and recorded room noise (+8.5 dB
 * SI-SDR at 5 dB SNR) for ~2% of one desktop core; GTCRN removes more of
 * steady and impulsive noise (+15 dB on fans, +11.5 dB on typing) for ~5%,
 * but thins the speaker's own voice by 2-5 dB when other people talk in the
 * room, so it is an opt-in "Strong" setting. Voice focus (teachers) turns
 * sound well below the teacher's own speaking level down between sentences.
 */
export type NoiseMode = 'standard' | 'enhanced' | 'strong';

export type VoiceSettings = {
  /** standard = the browser's own suppression; enhanced = RNNoise; strong = GTCRN. */
  noise: NoiseMode;
  /** Teachers only: turn down distant voices and residue between sentences. */
  focus: boolean;
};

export const VOICE_SETTINGS_KEY = 'classroom.voice.v1';

export const NOISE_MODES: { id: NoiseMode; label: string; hint: string }[] = [
  { id: 'standard', label: 'Standard', hint: "The browser's own noise suppression. Lightest on the device." },
  { id: 'enhanced', label: 'Enhanced', hint: 'AI noise removal (RNNoise): fans, traffic, room hum.' },
  { id: 'strong', label: 'Strong', hint: 'Stronger AI removal (GTCRN) for fans and typing. Can thin your voice when others talk nearby.' },
];

export function defaultVoiceSettings(isTeacher: boolean): VoiceSettings {
  return { noise: 'enhanced', focus: isTeacher };
}

export function parseVoiceSettings(raw: string | null | undefined, isTeacher: boolean): VoiceSettings {
  const d = defaultVoiceSettings(isTeacher);
  if (!raw) return d;
  try {
    const v = JSON.parse(raw) as Partial<VoiceSettings>;
    return {
      noise: NOISE_MODES.some((m) => m.id === v.noise) ? (v.noise as NoiseMode) : d.noise,
      focus: typeof v.focus === 'boolean' ? v.focus : d.focus,
    };
  } catch {
    return d;
  }
}

/** What the device offers, detected once per page (detectVoiceEnv in voiceProcessor.ts). */
export type VoiceEnv = {
  /** AudioContext + AudioWorklet available. */
  worklet: boolean;
  /** WebAssembly available. */
  wasm: boolean;
  /** navigator.hardwareConcurrency (2 when unknown). */
  cores: number;
  /** Phone-class device (coarse pointer, small screen). */
  phone: boolean;
};

export type VoicePlan = {
  denoiser: 'rnnoise' | 'gtcrn' | null;
  focus: boolean;
  /** Ask the browser for its own noise suppression (when no denoiser runs). */
  browserNs: boolean;
};

/** The processing chain to build for these settings on this device. */
export function planVoice(s: VoiceSettings, env: VoiceEnv, isTeacher: boolean): VoicePlan {
  if (!env.worklet) return { denoiser: null, focus: false, browserNs: true };
  const focus = isTeacher && s.focus;
  let denoiser: VoicePlan['denoiser'] = null;
  if (env.wasm && s.noise === 'enhanced') denoiser = 'rnnoise';
  // GTCRN costs ~2.5x RNNoise: desktops and tablets with 4+ cores.
  if (env.wasm && s.noise === 'strong') denoiser = env.cores >= 4 && !env.phone ? 'gtcrn' : 'rnnoise';
  return { denoiser, focus, browserNs: denoiser === null };
}

/** True when the plan needs an audio graph at all. */
export function needsGraph(p: VoicePlan): boolean {
  return p.denoiser !== null || p.focus;
}

/** Short status for the mic menu ("Enhanced noise removal", "Browser noise suppression"). */
export function planLabel(p: VoicePlan): string {
  const base = p.denoiser === 'gtcrn' ? 'Strong noise removal' : p.denoiser === 'rnnoise' ? 'Enhanced noise removal' : 'Browser noise suppression';
  return p.focus ? `${base} + voice focus` : base;
}
