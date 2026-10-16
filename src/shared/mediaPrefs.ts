/** Teacher mic/camera choice, remembered across rejoins and restarts (1c). */
export const MEDIA_PREFS_KEY = 'classroom.mediaPrefs';

export interface MediaPrefs { mic: boolean; cam: boolean }

export const DEFAULT_MEDIA_PREFS: MediaPrefs = { mic: true, cam: false };

export function parseMediaPrefs(raw: string | null | undefined): MediaPrefs {
  if (!raw) return { ...DEFAULT_MEDIA_PREFS };
  try {
    const v = JSON.parse(raw) as Partial<MediaPrefs>;
    return {
      mic: typeof v.mic === 'boolean' ? v.mic : DEFAULT_MEDIA_PREFS.mic,
      cam: typeof v.cam === 'boolean' ? v.cam : DEFAULT_MEDIA_PREFS.cam,
    };
  } catch {
    return { ...DEFAULT_MEDIA_PREFS };
  }
}

export function serializeMediaPrefs(p: MediaPrefs): string {
  return JSON.stringify({ mic: !!p.mic, cam: !!p.cam });
}
