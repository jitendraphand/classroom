//! Classroom screen-share sidecar (Windows teacher app, "Option A").
//!
//!   share-sidecar.exe <affinity-helper.exe> <helper capture args...>
//!
//! Runs the WGC capture helper as a child, reads its WGC1 frames directly
//! (they never enter Electron), composites the overlay ink layer, converts to
//! I420 and publishes the screen share to LiveKit as its own participant
//! (`teacher_…__screen`, token from POST /api/rooms/<code>/screen-token).
//! Share audio (WASAPI loopback of the default output) is published while on.
//!
//! stdin (from Electron main), one JSON object per line:
//!   first line: {"url","token","fps","videoFps","maxBitrate","videoBitrate","codec":"vp9"|"vp8","encoder":"hardware"|"software","crop":{x,y,w,h}|null,"audio":bool}
//!   {"op":"mode","videoMode":bool}   {"op":"fps","fps":n}   {"op":"audio","on":bool}
//!   {"op":"ink","fw","fh","x","y","w","h","bytes":N} followed by N raw RGBA bytes
//!   {"op":"ink-clear"}               {"op":"stop"}
//! stdout: WGC1 header-only heartbeats (20 bytes, size 0) ≤1/s with the
//!   composited frame size, so the app's supervisor / overlay sizing keep working.
//! stderr: the helper's JSON lines verbatim, plus {"event":"sidecar","state":…}.

mod logic;

use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding};
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::prelude::{AudioFrame, I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::rtp_sender::VideoEncoderBackend;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use logic::{composite_ink, crop_rect, even, share_profile, InkLayer, Pacer};
use serde::Deserialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAGIC: u32 = 0x3143_4757;

#[derive(Deserialize, Clone, Copy, Debug)]
struct Crop {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Deserialize)]
struct Config {
    url: String,
    token: String,
    #[serde(default = "d_fps")]
    fps: u32,
    #[serde(default = "d_vfps")]
    #[serde(rename = "videoFps")]
    video_fps: u32,
    #[serde(default = "d_br")]
    #[serde(rename = "maxBitrate")]
    max_bitrate: u64,
    #[serde(default = "d_vbr")]
    #[serde(rename = "videoBitrate")]
    video_bitrate: u64,
    #[serde(default)]
    codec: Option<String>,
    #[serde(default)]
    encoder: Option<String>,
    #[serde(default)]
    crop: Option<Crop>,
    #[serde(default)]
    audio: bool,
    /// Adaptive capture (weak / busy CPU): scale frames down to this height (0 = off).
    #[serde(default, rename = "maxHeight")]
    max_height: u32,
}
fn d_fps() -> u32 { 8 }
fn d_vfps() -> u32 { 24 }
fn d_br() -> u64 { 1_500_000 }
fn d_vbr() -> u64 { 2_500_000 }

#[derive(Deserialize)]
struct Ctl {
    op: String,
    #[serde(default, rename = "videoMode")]
    video_mode: Option<bool>,
    #[serde(default)]
    fps: Option<u32>,
    #[serde(default)]
    on: Option<bool>,
    #[serde(default)]
    fw: u32,
    #[serde(default)]
    fh: u32,
    #[serde(default)]
    x: u32,
    #[serde(default)]
    y: u32,
    #[serde(default)]
    w: u32,
    #[serde(default)]
    h: u32,
    #[serde(default)]
    bytes: usize,
    #[serde(default, rename = "maxHeight")]
    max_height: Option<u32>,
}

fn event(state: &str, why: &str) {
    let line = serde_json::json!({ "event": "sidecar", "state": state, "why": why }).to_string();
    let mut e = std::io::stderr().lock();
    let _ = writeln!(e, "{line}");
    let _ = e.flush();
}

/// Shared between the helper reader, the stdin control reader and the pacer.
struct Shared {
    raw: Mutex<Option<(u32, u32, Vec<u8>)>>,
    ink: Mutex<Option<InkLayer>>,
    fresh: AtomicBool,
    dirty_ink: AtomicBool,
    fps: AtomicU32,
    slides_fps: AtomicU32,
    video_fps: AtomicU32,
    video_mode: AtomicBool,
    audio_on: AtomicBool,
    max_height: AtomicU32,
    stop: AtomicBool,
    last_change: Mutex<Instant>,
}

fn set_priority(low: bool) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS};
        SetPriorityClass(GetCurrentProcess(), if low { BELOW_NORMAL_PRIORITY_CLASS } else { NORMAL_PRIORITY_CLASS });
    }
    #[cfg(not(windows))]
    let _ = low;
}

fn heartbeat(w: u32, h: u32) {
    let mut head = [0u8; 20];
    head[0..4].copy_from_slice(&MAGIC.to_le_bytes());
    head[4..8].copy_from_slice(&w.to_le_bytes());
    head[8..12].copy_from_slice(&h.to_le_bytes());
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(&head);
    let _ = out.flush();
}

fn read_helper_frames(mut src: impl Read, shared: Arc<Shared>) {
    let mut head = [0u8; 20];
    loop {
        if src.read_exact(&mut head).is_err() {
            break;
        }
        let u = |i: usize| u32::from_le_bytes([head[i], head[i + 1], head[i + 2], head[i + 3]]);
        let (magic, w, h, stride, size) = (u(0), u(4), u(8), u(12), u(16));
        if magic != MAGIC || w < 2 || h < 2 || w > 4096 || h > 4096 {
            event("error", "bad-frame");
            break;
        }
        if size == 0 && stride == 0 {
            continue; // helper heartbeat: picture unchanged
        }
        if stride != w * 4 || size != w * h * 4 {
            event("error", "bad-stride");
            break;
        }
        let mut buf = vec![0u8; size as usize];
        if src.read_exact(&mut buf).is_err() {
            break;
        }
        *shared.raw.lock().unwrap() = Some((w, h, buf));
        *shared.last_change.lock().unwrap() = Instant::now();
        shared.fresh.store(true, Ordering::Release);
    }
    shared.stop.store(true, Ordering::Release);
}

fn read_control(shared: Arc<Shared>, mut input: impl BufRead) {
    let mut line = String::new();
    loop {
        line.clear();
        match input.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(ctl) = serde_json::from_str::<Ctl>(line.trim()) else { continue };
        match ctl.op.as_str() {
            "mode" => {
                let on = ctl.video_mode.unwrap_or(false);
                shared.video_mode.store(on, Ordering::Release);
                let f = if on { shared.video_fps.load(Ordering::Acquire) } else { shared.slides_fps.load(Ordering::Acquire) };
                shared.fps.store(f, Ordering::Release);
            }
            "fps" => {
                let f = ctl.fps.unwrap_or(8).clamp(1, 30);
                if shared.video_mode.load(Ordering::Acquire) {
                    shared.video_fps.store(f, Ordering::Release);
                } else {
                    shared.slides_fps.store(f, Ordering::Release);
                }
                shared.fps.store(f, Ordering::Release);
            }
            "audio" => shared.audio_on.store(ctl.on.unwrap_or(false), Ordering::Release),
            "maxHeight" => shared.max_height.store(logic::clamp_max_height(ctl.max_height.unwrap_or(0)), Ordering::Release),
            "ink" => {
                if ctl.bytes > 64 * 1024 * 1024 {
                    break;
                }
                let mut rgba = vec![0u8; ctl.bytes];
                if input.read_exact(&mut rgba).is_err() {
                    break;
                }
                let layer = InkLayer { fw: ctl.fw, fh: ctl.fh, x: ctl.x, y: ctl.y, w: ctl.w, h: ctl.h, rgba };
                *shared.ink.lock().unwrap() = if layer.valid() { Some(layer) } else { None };
                shared.dirty_ink.store(true, Ordering::Release);
            }
            "ink-clear" => {
                *shared.ink.lock().unwrap() = None;
                shared.dirty_ink.store(true, Ordering::Release);
            }
            "stop" => break,
            _ => {}
        }
    }
    shared.stop.store(true, Ordering::Release);
}

/// WASAPI loopback of the default output device, 48 kHz stereo s16, 10 ms frames.
#[cfg(windows)]
fn loopback_thread(shared: Arc<Shared>, tx: tokio::sync::mpsc::Sender<Vec<i16>>) {
    use std::collections::VecDeque;
    use wasapi::*;
    let run = || -> Result<(), Box<dyn std::error::Error>> {
        let _ = initialize_mta();
        let device = get_default_device(&Direction::Render)?;
        let mut client = device.get_iaudioclient()?;
        let format = WaveFormat::new(16, 16, &SampleType::Int, 48_000, 2, None);
        let (_def, min) = client.get_device_period()?;
        client.initialize_client(&format, &Direction::Capture, &StreamMode::PollingShared { autoconvert: true, buffer_duration_hns: min.max(200_000) })?;
        let capture = client.get_audiocaptureclient()?;
        client.start_stream()?;
        let mut q: VecDeque<u8> = VecDeque::new();
        const CHUNK: usize = 480 * 2 * 2; // 10 ms
        while !shared.stop.load(Ordering::Acquire) {
            capture.read_from_device_to_deque(&mut q)?;
            while q.len() >= CHUNK {
                let bytes: Vec<u8> = q.drain(..CHUNK).collect();
                if !shared.audio_on.load(Ordering::Acquire) {
                    continue;
                }
                let samples: Vec<i16> = bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
                let _ = tx.try_send(samples);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let _ = client.stop_stream();
        Ok(())
    };
    if let Err(e) = run() {
        event("audio-error", &e.to_string());
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        event("error", "usage");
        std::process::exit(2);
    }
    let stdin = std::io::stdin();
    let mut input = BufReader::new(stdin);
    let mut first = String::new();
    if input.read_line(&mut first).is_err() {
        event("error", "no-config");
        std::process::exit(2);
    }
    let cfg: Config = match serde_json::from_str(first.trim()) {
        Ok(c) => c,
        Err(_) => {
            event("error", "bad-config");
            std::process::exit(2);
        }
    };

    // 1. Capture helper (child): frames → this process only.
    let mut child = match Command::new(&args[1]).args(&args[2..]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(_) => {
            event("error", "helper-spawn-failed");
            std::process::exit(3);
        }
    };
    let shared = Arc::new(Shared {
        raw: Mutex::new(None),
        ink: Mutex::new(None),
        fresh: AtomicBool::new(false),
        dirty_ink: AtomicBool::new(false),
        fps: AtomicU32::new(cfg.fps.clamp(1, 30)),
        slides_fps: AtomicU32::new(cfg.fps.clamp(1, 30)),
        video_fps: AtomicU32::new(cfg.video_fps.clamp(1, 30)),
        video_mode: AtomicBool::new(false),
        audio_on: AtomicBool::new(cfg.audio),
        max_height: AtomicU32::new(logic::clamp_max_height(cfg.max_height)),
        stop: AtomicBool::new(false),
        last_change: Mutex::new(Instant::now()),
    });
    let herr = child.stderr.take().unwrap();
    std::thread::spawn(move || {
        // The app parses the helper's ready / error / stale lines as before.
        for line in BufReader::new(herr).lines().map_while(Result::ok) {
            let mut e = std::io::stderr().lock();
            let _ = writeln!(e, "{line}");
            let _ = e.flush();
        }
    });
    let hout = child.stdout.take().unwrap();
    {
        let s = shared.clone();
        std::thread::spawn(move || read_helper_frames(hout, s));
    }
    {
        let s = shared.clone();
        std::thread::spawn(move || read_control(s, input));
    }

    // 2. LiveKit: publish-only participant.
    let mut opts = RoomOptions::default();
    opts.auto_subscribe = false;
    opts.dynacast = true;
    let (room, mut events) = match tokio::time::timeout(Duration::from_secs(12), Room::connect(&cfg.url, &cfg.token, opts)).await {
        Ok(Ok(r)) => r,
        Err(_) => {
            event("error", "connect: timeout");
            let _ = child.kill();
            std::process::exit(4);
        }
        Ok(Err(e)) => {
            event("error", &format!("connect: {e}"));
            let _ = child.kill();
            std::process::exit(4);
        }
    };
    event("connected", "");
    {
        let s = shared.clone();
        tokio::spawn(async move {
            while let Some(ev) = events.recv().await {
                if let RoomEvent::Disconnected { reason } = ev {
                    event("error", &format!("disconnected {reason:?}"));
                    s.stop.store(true, Ordering::Release);
                    break;
                }
            }
        });
    }

    // Wait for the first frame to size the source.
    let started = Instant::now();
    let (fw, fh) = loop {
        if let Some((w, h, _)) = shared.raw.lock().unwrap().as_ref() {
            break (*w, *h);
        }
        if shared.stop.load(Ordering::Acquire) || started.elapsed() > Duration::from_secs(10) {
            event("error", "no-frames");
            let _ = child.kill();
            std::process::exit(5);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let (_, _, cw0, ch0) = crop_rect(fw, fh, cfg.crop.map(|c| (c.x, c.y, c.w, c.h)));
    let backend = match cfg.encoder.as_deref() {
        Some("software") => VideoEncoderBackend::Software,
        _ => VideoEncoderBackend::Hardware, // falls back to software when no hardware encoder exists
    };
    let vp9 = cfg.codec.as_deref() != Some("vp8");
    let lp = room.local_participant();
    // Slides: screen content (detail) at the slide rate. Video mode: a
    // non-screencast source (WebRTC's "motion" content type: camera-like rate
    // control, no screenshare frame dropping) at the video rate. The content
    // type is fixed when a source is created and the LiveKit SDK does not
    // expose the RTP sender, so a mode switch republishes the track.
    let publish_profile = |video: bool| {
        let lp = lp.clone();
        let prof = share_profile(video, cfg.fps, cfg.video_fps, cfg.max_bitrate, cfg.video_bitrate);
        async move {
            let source = NativeVideoSource::new(VideoResolution { width: cw0, height: ch0 }, prof.screencast);
            let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
            let opts = |codec: VideoCodec, svc: Option<String>| TrackPublishOptions {
                source: TrackSource::Screenshare,
                video_codec: codec,
                simulcast: false,
                scalability_mode: svc,
                video_encoder: backend,
                video_encoding: Some(VideoEncoding { max_bitrate: prof.max_bitrate, max_framerate: prof.max_fps as f64 }),
                ..Default::default()
            };
            if vp9 {
                match lp.publish_track(LocalTrack::Video(track.clone()), opts(VideoCodec::VP9, Some("L1T3".into()))).await {
                    Ok(p) => return Ok((source, p, "vp9")),
                    Err(e) => event("vp9-failed", &e.to_string()),
                }
            }
            lp.publish_track(LocalTrack::Video(track), opts(VideoCodec::VP8, None)).await.map(|p| (source, p, "vp8"))
        }
    };
    let (mut source, mut published, codec) = match publish_profile(false).await {
        Ok(v) => v,
        Err(e) => {
            event("error", &format!("publish: {e}"));
            let _ = child.kill();
            std::process::exit(6);
        }
    };
    let mut cur_video = false;
    event("published", codec);

    // 3. Share audio (published once; frames flow only while on).
    #[cfg(windows)]
    {
        let audio_src = NativeAudioSource::new(AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false }, 48_000, 2, 100);
        let atrack = LocalAudioTrack::create_audio_track("screen-audio", RtcAudioSource::Native(audio_src.clone()));
        let aopts = TrackPublishOptions { source: TrackSource::ScreenshareAudio, dtx: false, red: false, ..Default::default() };
        if let Err(e) = lp.publish_track(LocalTrack::Audio(atrack), aopts).await {
            event("audio-error", &e.to_string());
        } else {
            let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<i16>>(50);
            let s = shared.clone();
            std::thread::spawn(move || loopback_thread(s, tx));
            tokio::spawn(async move {
                while let Some(samples) = rx.recv().await {
                    let frame = AudioFrame { data: samples.into(), sample_rate: 48_000, num_channels: 2, samples_per_channel: 480 };
                    let _ = audio_src.capture_frame(&frame).await;
                }
            });
        }
    }

    // 4. Pacer: changed frames at ≤fps, ink re-composites over a static screen,
    //    a 1 s refresh so late joiners get a keyframe. Below-normal priority
    //    after 3 s without a change.
    let mut pacer = Pacer::new();
    let mut last_hb = Instant::now() - Duration::from_secs(2);
    let mut low = false;
    let t0 = Instant::now();
    let mut work: Vec<u8> = Vec::new();
    while !shared.stop.load(Ordering::Acquire) {
        let fps = shared.fps.load(Ordering::Acquire).max(1);
        tokio::time::sleep(Duration::from_millis(5)).await;
        let want_video = shared.video_mode.load(Ordering::Acquire);
        if want_video != cur_video {
            // Publish the new profile first, then drop the old track: students
            // switch to the new screen-share track with only a short gap.
            match publish_profile(want_video).await {
                Ok((s2, p2, c2)) => {
                    let old = std::mem::replace(&mut published, p2);
                    let _ = lp.unpublish_track(&old.sid()).await;
                    source = s2;
                    cur_video = want_video;
                    pacer = Pacer::new();
                    shared.fresh.store(true, Ordering::Release);
                    event("republished", &format!("{} {}", if want_video { "video" } else { "slides" }, c2));
                }
                Err(e) => {
                    // Keep the current track; retry only on the next switch.
                    event("mode-failed", &e.to_string());
                    cur_video = want_video;
                }
            }
        }
        let now = Instant::now();
        let fresh = shared.fresh.load(Ordering::Acquire);
        let ink = shared.dirty_ink.load(Ordering::Acquire);
        if !pacer.due(now, fps, fresh || ink) {
            continue;
        }
        let static_for = now.duration_since(*shared.last_change.lock().unwrap());
        let want_low = static_for > Duration::from_secs(3);
        if want_low != low {
            set_priority(want_low);
            low = want_low;
        }
        shared.fresh.store(false, Ordering::Release);
        shared.dirty_ink.store(false, Ordering::Release);
        let (w, h) = {
            let guard = shared.raw.lock().unwrap();
            let Some((w, h, raw)) = guard.as_ref() else { continue };
            work.clear();
            work.extend_from_slice(raw);
            (*w, *h)
        };
        if let Some(layer) = shared.ink.lock().unwrap().as_ref() {
            composite_ink(&mut work, w, h, layer);
        }
        let (cx, cy, cw, ch) = crop_rect(w, h, cfg.crop.map(|c| (c.x, c.y, c.w, c.h)));
        let mut buf = I420Buffer::new(cw, ch);
        let (sy, su, sv) = buf.strides();
        let (dy, du, dv) = buf.data_mut();
        let off = ((cy * w + cx) * 4) as usize;
        livekit::webrtc::native::yuv_helper::abgr_to_i420(&work[off..], w * 4, dy, sy, du, su, dv, sv, cw as i32, ch as i32);
        // Adaptive capture: weak or busy CPU → encode a smaller picture (libyuv scale).
        let max_h = shared.max_height.load(Ordering::Acquire);
        if let Some((tw, th)) = logic::scaled_size(cw, ch, max_h) {
            buf = buf.scale(tw as i32, th as i32);
        }
        let frame = VideoFrame { rotation: VideoRotation::VideoRotation0, timestamp_us: t0.elapsed().as_micros() as i64, frame_metadata: None, buffer: buf };
        source.capture_frame(&frame);
        if now.duration_since(last_hb) >= Duration::from_millis(1000) {
            heartbeat(w, h);
            last_hb = now;
        }
    }
    let _ = child.kill();
    let _ = lp.unpublish_track(&published.sid()).await;
    let _ = room.close().await;
    event("stopped", "");
    let _ = even(0);
}
