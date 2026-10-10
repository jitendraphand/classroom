/** Chromium features that let WebRTC use Windows hardware video encoders (Media Foundation: NVENC/QSV/AMF behind it). */
export const HW_ENCODE_FEATURES = ['MediaFoundationVP9Encoding', 'MediaFoundationAV1Encoding', 'MediaFoundationH264Encoding'] as const;
/** Chromium switches that would force software encoding; never appended. */
export const HW_ENCODE_BLOCKERS = ['disable-accelerated-video-encode', 'disable-gpu'] as const;
