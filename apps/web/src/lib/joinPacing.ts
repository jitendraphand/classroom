import { ensureRedis } from './redis';
import { PACE_LUA, joinConnectRate, joinSpreadMaxMs } from './joinPacingLogic';

const CLOCK_KEY = 'join:pace';

/** A student's connect delay (ms) for the current join wave; 0 when idle or Redis is down. */
export async function nextConnectDelayMs(now = Date.now()): Promise<number> {
  const max = joinSpreadMaxMs();
  if (max <= 0) return 0;
  const gap = 1000 / joinConnectRate();
  try {
    const redis = await ensureRedis();
    const d = Number(await redis.eval(PACE_LUA, 1, CLOCK_KEY, String(now), String(gap), String(max)));
    if (!Number.isFinite(d) || d <= 0) return 0;
    // Small jitter so slots handed out in the same ms do not connect together.
    return Math.round(d + Math.random() * Math.min(250, gap * 2));
  } catch {
    return 0;
  }
}
