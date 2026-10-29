/**
 * Configuration from the environment (see README.md). Credentials are the
 * AI teacher's own TEACHER account, created by a school admin.
 */
import { Audit } from './audit';
import { DEFAULT_POLICY, type Policy } from './reflex';
import { HttpStt, HttpTts } from './speech';
import type { TeacherConfig } from './tools';

export function fromEnv(env = process.env): { base: string; cfg: TeacherConfig } {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`Set ${k} (see apps/ai-teacher/README.md).`);
    return v;
  };
  const admit = env.AI_TEACHER_ADMIT === 'all' || env.AI_TEACHER_ADMIT === 'manual' ? env.AI_TEACHER_ADMIT : DEFAULT_POLICY.admit;
  const policy: Policy = { ...DEFAULT_POLICY, admit };
  const tts = env.AI_TEACHER_TTS_URL
    ? new HttpTts(env.AI_TEACHER_TTS_URL, env.AI_TEACHER_TTS_KEY, env.AI_TEACHER_TTS_MODEL || 'tts-1', env.AI_TEACHER_TTS_VOICE || 'alloy', Number(env.AI_TEACHER_TTS_RATE) || 24000)
    : null;
  const stt = env.AI_TEACHER_STT_URL ? new HttpStt(env.AI_TEACHER_STT_URL, env.AI_TEACHER_STT_KEY, env.AI_TEACHER_STT_MODEL || 'whisper-1', env.AI_TEACHER_STT_LANGUAGE) : null;
  return {
    base: need('CLASSROOM_URL'),
    cfg: {
      email: need('CLASSROOM_EMAIL'),
      password: need('CLASSROOM_PASSWORD'),
      policy,
      tts,
      stt,
      audit: new Audit(env.AI_TEACHER_AUDIT || 'ai-teacher-audit.jsonl'),
      minClassMinutes: Number(env.AI_TEACHER_MIN_MINUTES ?? 20),
      allowLinks: env.AI_TEACHER_ALLOW_LINKS === '1',
      mediaDir: env.AI_TEACHER_MEDIA_DIR || null,
      alertUrl: env.AI_TEACHER_ALERT_URL || null,
      control: env.AI_TEACHER_CONTROL_PORT
        ? { port: Number(env.AI_TEACHER_CONTROL_PORT), host: env.AI_TEACHER_CONTROL_HOST || '127.0.0.1', token: need('AI_TEACHER_CONTROL_TOKEN') }
        : null,
    },
  };
}
