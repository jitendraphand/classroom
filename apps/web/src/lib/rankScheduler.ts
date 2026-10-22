import { runIfLeader } from './leaderLock';
import { keys } from './redis';
import { ensureWeeklySnapshots } from './rankingService';

const HOUR_MS = 60 * 60 * 1000;

/** Hourly check on one worker (Redis lock). The first tick waits so boot can finish migrate. */
export function startRankScheduler() {
  const tick = () => {
    void runIfLeader(keys.leaderRank(), 55, () => ensureWeeklySnapshots()).catch((e) =>
      console.error('[rank] weekly snapshot', e)
    );
  };
  const first = setTimeout(tick, 20_000);
  const every = setInterval(tick, HOUR_MS);
  first.unref?.();
  every.unref?.();
}
