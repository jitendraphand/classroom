//! Pure helpers (unit-tested on Linux with `cargo test`).
use std::time::{Duration, Instant};

/// Encoder profile for one share mode.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct ShareProfile {
    /// WebRTC screen content (text detail, screenshare rate control) vs motion.
    pub screencast: bool,
    pub max_fps: u32,
    pub max_bitrate: u64,
}

/// Slides: screen content at the slide rate. Video mode: motion (not
/// screencast) at the video rate (≤30) and the video bitrate.
pub fn share_profile(video: bool, slides_fps: u32, video_fps: u32, max_bitrate: u64, video_bitrate: u64) -> ShareProfile {
    if video {
        ShareProfile { screencast: false, max_fps: video_fps.clamp(1, 30), max_bitrate: video_bitrate.max(max_bitrate) }
    } else {
        ShareProfile { screencast: true, max_fps: slides_fps.clamp(1, 30), max_bitrate }
    }
}

pub struct InkLayer {
    pub fw: u32,
    pub fh: u32,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub rgba: Vec<u8>,
}

impl InkLayer {
    pub fn valid(&self) -> bool {
        self.w > 0
            && self.h > 0
            && self.x + self.w <= self.fw
            && self.y + self.h <= self.fh
            && self.rgba.len() == (self.w * self.h * 4) as usize
    }
}

/// Same blend as src/shared/inkLayer.ts compositeInkLayer (source-over, RGBA).
pub fn composite_ink(frame: &mut [u8], width: u32, height: u32, layer: &InkLayer) -> bool {
    if layer.fw != width || layer.fh != height || !layer.valid() || frame.len() < (width * height * 4) as usize {
        return false;
    }
    for row in 0..layer.h {
        for col in 0..layer.w {
            let si = ((row * layer.w + col) * 4) as usize;
            let a = layer.rgba[si + 3] as u32;
            if a == 0 {
                continue;
            }
            let di = (((layer.y + row) * width + layer.x + col) * 4) as usize;
            if a == 255 {
                frame[di..di + 3].copy_from_slice(&layer.rgba[si..si + 3]);
                continue;
            }
            let inv = 255 - a;
            for k in 0..3 {
                frame[di + k] = ((layer.rgba[si + k] as u32 * a + frame[di + k] as u32 * inv + 127) / 255) as u8;
            }
        }
    }
    true
}

pub fn even(v: u32) -> u32 {
    v & !1
}

/// Region share: fractions of the full frame → even-sized pixel rect inside it.
pub fn crop_rect(w: u32, h: u32, crop: Option<(f64, f64, f64, f64)>) -> (u32, u32, u32, u32) {
    let Some((fx, fy, fw, fh)) = crop else { return (0, 0, even(w), even(h)) };
    let clamp = |v: f64| v.clamp(0.0, 1.0);
    let x = (clamp(fx) * w as f64).round() as u32;
    let y = (clamp(fy) * h as f64).round() as u32;
    let x = x.min(w.saturating_sub(2));
    let y = y.min(h.saturating_sub(2));
    let cw = even(((clamp(fw) * w as f64).round() as u32).clamp(2, w - x));
    let ch = even(((clamp(fh) * h as f64).round() as u32).clamp(2, h - y));
    (x, y, cw.max(2), ch.max(2))
}

/// Frame pacing: a changed frame at most every 1/fps; otherwise a 1 s refresh.
pub struct Pacer {
    last: Option<Instant>,
}

impl Pacer {
    pub fn new() -> Self {
        Self { last: None }
    }
    pub fn due(&mut self, now: Instant, fps: u32, changed: bool) -> bool {
        let gap = Duration::from_millis(1000 / fps.max(1) as u64);
        let ok = match self.last {
            None => true,
            Some(t) => {
                let since = now.duration_since(t);
                (changed && since >= gap) || since >= Duration::from_millis(1000)
            }
        };
        if ok {
            self.last = Some(now);
        }
        ok
    }
}

/// Adaptive capture height: 0 = off, else at least 360 (legible slides).
pub fn clamp_max_height(h: u32) -> u32 {
    if h == 0 { 0 } else { h.clamp(360, 1080) }
}

/// Target size when a frame is taller than `max_h` (even dimensions, aspect kept); None = no scaling.
pub fn scaled_size(w: u32, h: u32, max_h: u32) -> Option<(u32, u32)> {
    if max_h == 0 || h <= max_h || w == 0 || h == 0 {
        return None;
    }
    let th = max_h & !1;
    let tw = ((w as u64 * th as u64 / h as u64) as u32).max(2) & !1;
    Some((tw, th))
}

#[cfg(test)]
mod tests {
    #[test]
    fn adaptive_scale_keeps_aspect_and_even_sizes() {
        assert_eq!(super::scaled_size(1920, 1080, 0), None);
        assert_eq!(super::scaled_size(1280, 720, 720), None);
        assert_eq!(super::scaled_size(1920, 1080, 720), Some((1280, 720)));
        assert_eq!(super::scaled_size(1366, 768, 541), Some((960, 540)));
        assert_eq!(super::clamp_max_height(100), 360);
        assert_eq!(super::clamp_max_height(0), 0);
        assert_eq!(super::clamp_max_height(5000), 1080);
    }
    #[test]
    fn slides_are_screen_content_video_is_motion_30() {
        let slides = share_profile(false, 8, 30, 700_000, 1_500_000);
        assert_eq!(slides, ShareProfile { screencast: true, max_fps: 8, max_bitrate: 700_000 });
        let video = share_profile(true, 8, 30, 700_000, 1_500_000);
        assert_eq!(video, ShareProfile { screencast: false, max_fps: 30, max_bitrate: 1_500_000 });
        assert_eq!(share_profile(true, 8, 60, 1, 1).max_fps, 30);
    }

    use super::*;

    #[test]
    fn composite_matches_ts_blend() {
        let mut f = vec![100u8; 4 * 4 * 4];
        let layer = InkLayer { fw: 4, fh: 4, x: 1, y: 1, w: 2, h: 1, rgba: vec![255, 0, 0, 255, 0, 0, 255, 128] };
        assert!(composite_ink(&mut f, 4, 4, &layer));
        let p = ((1 * 4 + 1) * 4) as usize;
        assert_eq!(&f[p..p + 3], &[255, 0, 0]);
        let q = p + 4;
        assert_eq!(f[q], ((0 * 128 + 100 * 127 + 127) / 255) as u8);
        assert_eq!(f[q + 2], ((255 * 128 + 100 * 127 + 127) / 255) as u8);
        assert_eq!(f[0], 100);
    }

    #[test]
    fn composite_rejects_wrong_size() {
        let mut f = vec![0u8; 16];
        let layer = InkLayer { fw: 8, fh: 8, x: 0, y: 0, w: 1, h: 1, rgba: vec![1, 2, 3, 255] };
        assert!(!composite_ink(&mut f, 2, 2, &layer));
    }

    #[test]
    fn crop_whole_and_region() {
        assert_eq!(crop_rect(1921, 1080, None), (0, 0, 1920, 1080));
        assert_eq!(crop_rect(1920, 1080, Some((0.5, 0.5, 0.25, 0.25))), (960, 540, 480, 270));
        let (x, y, w, h) = crop_rect(1920, 1080, Some((0.9, 0.9, 0.5, 0.5)));
        assert!(x + w <= 1920 && y + h <= 1080 && w % 2 == 0 && h % 2 == 0);
    }

    #[test]
    fn pacer_caps_rate_and_refreshes() {
        let t = Instant::now();
        let mut p = Pacer::new();
        assert!(p.due(t, 8, true));
        assert!(!p.due(t + Duration::from_millis(50), 8, true));
        assert!(p.due(t + Duration::from_millis(130), 8, true));
        assert!(!p.due(t + Duration::from_millis(600), 8, false));
        assert!(p.due(t + Duration::from_millis(1200), 8, false));
    }
}
