# Android teacher app: supported versions and OS limits

Supported: Android 8.0 (API 26, minSdk) to Android 15 (API 35, targetSdk). Phones from 360dp wide,
large phones, tablets and foldables, portrait and landscape (window size classes: compact < 600dp,
medium < 840dp, expanded ≥ 840dp). Display cutouts are handled by insets; text uses sp, so system
font scaling applies.

| Feature | 8.0–9 (26–28) | 10–11 (29–30) | 12–13 (31–33) | 14–15 (34–35) |
|---|---|---|---|---|
| Class, chat, roster, camera, mic | yes | yes | yes | yes |
| Screen share (MediaProjection) | yes | yes | yes | yes, one consent per share session |
| Pause / resume share without a new prompt | yes | yes | yes | yes (projection + foreground service kept) |
| Floating bubble (overlay permission) | yes | yes | yes | yes |
| Student ink over the shared screen | yes | yes | yes, overlay at 80 % opacity* | same* |
| Cutout-aware ink overlay | no cutout API (API 26–27) | yes | yes | yes |
| Notification permission prompt | not needed | not needed | not needed | asked (API 33+) |
| Whiteboard host (local + server copy) | yes | yes | yes | yes |

\* Android 12+ blocks touches passing through non-trusted overlays with opacity above 0.8; the ink
overlay is touch-through, so it is drawn at 0.8 opacity. Students see the ink at full strength
because their copy fades only after it appears in the capture.

OS limits
- Android 14+: a MediaProjection token is single-use. Stopping the share (Stop, system "Stop sharing"
  chip, leaving) needs a new consent next time; pausing does not.
- The system can revoke projection at any time (status-bar chip, lock screen on some OEMs); the app
  then ends the share cleanly.
- Some OEM skins kill background foreground services aggressively; keep battery optimisation off for
  the app on such phones.
- Secure windows (banking apps, password fields) appear black in the capture.
