/**
 * Supervisor control for the running AI teacher: a small HTTP endpoint the
 * school's supervisor (or a staff dashboard) calls to pause, resume or stop
 * the AI mid-class and to see its status. Token-protected, bound to
 * localhost unless configured otherwise.
 *
 *   GET  /status                          -> class, paused, ended, students, minutes, escalations
 *   POST /pause | /resume | /stop          -> applied at once (stop: the AI says goodbye and ends)
 *   Authorization: Bearer $AI_TEACHER_CONTROL_TOKEN
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { TeacherSession } from './tools';

export function startControl(session: TeacherSession, opts: { port: number; host: string; token: string }): http.Server {
  if (opts.token.length < 16) throw new Error('AI_TEACHER_CONTROL_TOKEN must be at least 16 characters.');
  const want = Buffer.from(`Bearer ${opts.token}`);
  const server = http.createServer((req, res) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (got.length !== want.length || !timingSafeEqual(got, want)) return send(401, { error: 'unauthorized' });
    const live = session.live;
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/status') {
      return send(200, {
        class: live?.code ?? null,
        name: live?.state?.name ?? null,
        paused: live?.paused ?? false,
        ended: live?.ended ?? false,
        students: live?.state?.admittedStudentCount ?? 0,
        minutes: live ? Math.floor((Date.now() - session.startedAt) / 60_000) : 0,
        escalations: live?.reflex.escalationLog.length ?? 0,
      });
    }
    const cmd = req.method === 'POST' && /^\/(pause|resume|stop)$/.exec(path)?.[1];
    if (cmd) {
      if (!live) return send(409, { error: 'not in a class' });
      live.supervise(cmd as 'pause' | 'resume' | 'stop', 'control');
      return send(200, { ok: true, paused: live.paused });
    }
    send(404, { error: 'not found' });
  });
  server.listen(opts.port, opts.host);
  return server;
}
