# Clear audio: noise removal and voice focus

How the classroom cleans up microphones, what each setting does, what it
costs, and how it was measured. Code: `apps/web/src/lib/audio/`
(`voiceSettings.ts` = choices and per-device plan, `voiceProcessor.ts` =
audio graph), `apps/web/public/audio/voice-focus-worklet.js`, the mic menu
`apps/web/src/components/classroom/MicOptions.tsx`.

## What runs

```
mic (browser: echo cancellation, AGC; its noise suppression only in Standard)
  -> high-pass 70 Hz (desk thumps, HVAC rumble)
  -> noise removal: Enhanced = RNNoise, Strong = GTCRN   (WebAssembly AudioWorklet)
  -> voice focus (teachers)                              (AudioWorklet, plain JS)
  -> published microphone (Opus speech, DTX; teacher also RED)
```

| Setting (mic caret ▾) | Who | What it is |
| --- | --- | --- |
| **Standard** | everyone | The browser's own noise suppression. Lightest. |
| **Enhanced** (default) | everyone | RNNoise (Xiph, BSD-3): a small recurrent network trained on speech vs. noise. Removes fans, AC, traffic, room hum. |
| **Strong** | everyone; desktops/tablets with 4+ cores | GTCRN (MIT, 2024): a stronger network. Removes much more of fans and typing, but thins your own voice by 2-5 dB when other people talk in the room, so it is opt-in. On phones and 2-core machines it runs Enhanced instead. |
| **Voice focus** (default on) | teachers | Learns the teacher's own speaking level (the loudest 10% of what they said over the last ~20 s, so a cough or a door slam does not move it) and turns down sound more than 15 dB under it between sentences: people talking further away, a TV next door, what the noise remover lets through. Never touches sound at the teacher's level and turns nothing down until the teacher has been heard; opens 8 ms before a word starts (look-ahead) and holds 120 ms after it ends. |

The Windows teacher app runs the same chain (synced from the web app) and
has the same choices in its Devices panel. The Android teacher app keeps the
phone's own processing and adds voice focus (see below).

Settings are saved per device (`localStorage` key `classroom.voice.v1`). A
change republishes the microphone (a ~0.5 s gap for listeners). Students
download the models only the first time they turn their mic on (RNNoise
~220 KB, GTCRN ~205 KB, cached by the browser).

## It never breaks the microphone

Every step falls back to the plain browser-processed microphone (echo
cancellation, noise suppression, AGC), and the mic menu says why:

- no AudioWorklet / WebAssembly, or no 48 kHz audio: plain mic;
- the audio context will not start (Safari before a tap): plain mic, and the
  next tap or click republishes it cleaned up;
- worklet or model fails to download, or the model does not compile: plain mic;
- the processor fails to start: stopped, mic restarted with the browser's suppression;
- **watchdog**: if the chain outputs digital silence while the mic hears
  sound (a model that never loaded) or the audio context stops, it falls
  back mid-class within ~2.5 s.

Checked in headless Chromium with a fake mic (speech + recorded noise):
all three modes, Standard + focus, worklet 404, model 404, corrupt model,
and a worklet that outputs silence (watchdog) all leave a live, audible mic.
And in a real class (local LiveKit, teacher + 2 students): both students
receive the teacher's audio in Enhanced, Standard and Strong, with mode
switches mid-class (`class-audio` run, 2026-10-28: all checks pass).

## Measurements

24 s of read speech (LibriSpeech/TIMIT samples from the speechbrain test
set, 16 kHz upsampled to 48 kHz) with 1.2 s pauses, mixed with noise.
SI-SDR = scale-invariant signal-to-distortion ratio of the output against
the clean speech, in dB (higher is better; the shipped-chain columns are
compared with the clean speech through the same high-pass, whose
low-frequency phase shift is inaudible but would otherwise count as
distortion). "Own voice" = change of the speaker's own level (should stay
near 0 dB).

| Noise (SNR) | Input | RNNoise | GTCRN | **Enhanced** (shipped chain) | **Strong** (shipped chain) | Own voice, Strong |
| --- | --- | --- | --- | --- | --- | --- |
| Clean speech | 96 | 22.1 | 25.6 | 27.4 | 19.1 | +0.2 dB |
| Fan + 120 Hz hum (5 dB) | 2.7 | 11.2 | 17.6 | 10.4 | **15.8** | -0.1 dB |
| Recorded room noise (5 dB) | 2.7 | 11.2 | 11.7 | 11.4 | **12.6** | -0.3 dB |
| Typing / clicks (10 dB) | 7.7 | 13.3 | 19.2 | 14.4 | **16.6** | +0.1 dB |
| Distant talkers, reverberant (10 dB) | 7.7 | 9.7 | 7.7 | **9.8** | 7.4 | **-3.6 dB** |
| Distant talkers (20 dB) | 17.7 | 16.6 | 13.5 | **18.2** | 12.5 | -0.5 dB |

"Shipped chain" = high-pass + noise remover + voice focus, exactly as a
teacher's mic runs it; RNNoise / GTCRN = the noise remover alone.

Between sentences (pause level, dBFS), shipped Enhanced chain vs RNNoise
alone: recorded room noise -50.4 vs -49.4, distant talkers (20 dB) -52.4 vs
-48.7 (input -44); typing -42.5 with Enhanced, -79.5 with Strong (input
-34). The teacher's own level never moved by more than 0.3 dB with
Enhanced.

CPU (fraction of one core, Xeon 2.1 GHz, Chromium): Enhanced 1.9%, Strong
5.5%, voice focus 0.1%, plain 0.05%. A mid-range phone is roughly 4-6x
slower, which is why Strong is limited to 4+ core non-phone devices.
Latency added: Enhanced 21 ms, Strong 32 ms, voice focus 8 ms.

Reproduce: the harness mixes the clips (`mix.py`), renders each chain in an
`OfflineAudioContext` with the shipped worklets (`run.mjs`) and scores it
(`analyze.py`); the browser fallback checks are `drive.mjs`. They were run
from a scratch directory and are not part of CI; the unit tests
(`apps/web/tests/voice.test.ts`) cover the plan, the voice-focus DSP and
the asset names.

## Personalised voice isolation (teachers)

What exists today:

- **Voice focus** above is personalised to the teacher's *level*: it learns
  how loud this teacher is at this mic and keeps only sound near that.
- True *speaker-conditioned* isolation (keep only the enrolled teacher's
  voice even when someone else speaks equally loud nearby) needs a speaker
  embedding model; no open model small enough for the browser exists yet.
  The device-level features do this well and the classroom uses them
  automatically because it captures the system microphone:
  - macOS: Control Center > Mic Mode > **Voice Isolation** (Safari, Chrome).
  - Windows 11: Settings > System > Sound > microphone > **Voice clarity** /
    Windows Studio Effects **Voice focus** (on supported PCs).
  - NVIDIA Broadcast or Krisp desktop: pick their virtual microphone as the
    default input.
  - Android: the teacher app records with the phone's voice-communication
    input (hardware echo cancellation and noise suppression on Android 10+),
    WebRTC's own suppression, AGC and high-pass, then the same voice focus
    as the web (Kotlin port, `apps/android/.../VoiceFocus.kt` on the android
    branch; long-press the mic button to turn it off or on).

If a teacher uses one of these, set the classroom to **Standard** to avoid
stacking two noise removers.

## Listening side

- One audio element per remote track (no doubled playback on reconnect).
- Teacher voice: Opus speech preset with RED (each frame sent twice, so a
  lost packet does not make a gap) and DTX (no bits during silence).
- Student mics: no RED (N speaking students would cost every listener 2N
  streams), DTX on.
- Shared system audio is captured only when the browser confirms it
  excludes the classroom's own output (no echo of students to themselves).
