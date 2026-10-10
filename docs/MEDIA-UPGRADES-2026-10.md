# Media / push upgrades (2026-10-10)

Measured locally (LiveKit 1.13.9, 1 teacher sharing + camera, 6 students:
3 laptop 1280x720, 3 phone 412x915 viewports; Chrome fake capture = an
animated 30 fps test pattern, i.e. worst case, not a static slide), 60 s window.

| per student | before (15fd143) | after |
|---|---|---|
| share video in | 238 kbps @720p10 (laptop) / 571 kbps @1080p15 (phone) | 165 kbps @1080p, VP9, 4 fps |
| teacher camera in | 101 kbps (180p layer) | 149 kbps (360p single layer, 15 fps) |
| total video in | 339 / 673 kbps (avg 506) | 314 kbps |
| own camera up (share, panel minimized) | 61-124 kbps | 0 (paused; 118-123 kbps when the panel is expanded) |
| /api requests per minute | 15-17 | 4-5 |
| teacher /api requests per minute | 21 | 8-9 |
| teacher video up | 1021 kbps | 418 kbps |

WebKit (Playwright) student negotiated VP9 directly; the VP8 backup layer is
only started for subscribers without VP9 (not reproducible in Playwright).
