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
| **Voice focus** (default on) | teachers | Learns the teacher's own speaking level while they talk and turns down sound more than 18 dB under it between sentences: people talking further away, a TV next door, what the noise remover lets through. Never touches sound at the teacher's level; opens 8 ms before a word starts (look-ahead) and holds 120 ms after it ends. |

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
the clean speech (higher is better; the voice-focus rows are compared with
the clean speech through the same 70-80 Hz high-pass, whose low-frequency
phase shift is inaudible but would otherwise count as distortion). "Speech"
= change of the speaker's own level (should stay near 0 dB).

| Noise (SNR) | Input | Enhanced | Strong | Enhanced + focus | Speech level, Strong |
| --- | --- | --- | --- | --- | --- |
| Clean speech | 96 dB | 22.1 | 25.6 | 27.5 | 0.0 dB |
| Fan + 120 Hz hum (5 dB) | 2.7 | 11.2 | **17.6** | 10.4 | -0.2 dB |
| Recorded room noise (5 dB) | 2.7 | 11.2 | 11.7 | 11.4 | -0.6 dB |
| Typing / clicks (10 dB) | 7.7 | 13.3 | **19.2** | 14.4 | -0.1 dB |
| Distant talkers, reverberant (10 dB) | 7.7 | 9.7 | 7.7 | 9.8 | **-3.7 dB** |
| Distant talkers (20 dB) | 17.7 | 16.6 | 13.5 | **18.0** | -0.7 dB |

Between sentences (pause level, dBFS): distant talkers at 20 dB go from
-44 (input) to -48.7 (Enhanced) and -50.5 (Enhanced + focus); typing from
-34 to -41 (Enhanced) and -78 (Strong).

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
  - Android: the teacher app uses the phone's voice-communication input
    (hardware echo cancellation and noise suppression where the phone has them).

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
