import Link from 'next/link';
import { AppHeader, LogoMark } from '@/components/layout/AppHeader';
import { Badge } from '@/components/ui/Badge';
import { IconCheck } from '@/components/ui/Icons';

const features = [
  'Waiting room with admit controls',
  'Selective student video (bandwidth-aware)',
  'Shared tldraw whiteboard',
  'Screen share and mute controls',
  'In-class chat (broadcast + DM)',
  'One-command Docker Compose start',
];

export default function HomePage() {
  return (
    <main className="page-shell flex flex-col">
      <AppHeader
        right={
          <>
            <Link href="/login" className="btn-secondary">
              Teacher login
            </Link>
            <Link href="/register" className="btn-primary">
              Get started
            </Link>
          </>
        }
      />

      <section className="mt-8 grid flex-1 gap-12 lg:mt-14 lg:grid-cols-2 lg:items-center">
        <div>
          <Badge tone="brand" className="mb-4">
            Live teaching · Privacy-minded
          </Badge>
          <h1 className="font-display text-4xl font-semibold leading-[1.1] tracking-tight text-white sm:text-5xl">
            Teach live classes without streaming every student camera.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-300">
            Students join with a room code — no accounts. Teachers admit from a waiting room. Only a
            rotating sample of student videos reaches the teacher; everyone else stays local-only while
            still feeling present.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/register" className="btn-primary px-6 py-3 text-base">
              Create teacher account
            </Link>
            <Link href="/join" className="btn-secondary px-6 py-3 text-base">
              Join as student
            </Link>
          </div>
          <ul className="mt-10 grid gap-2.5 text-sm text-slate-300 sm:grid-cols-2">
            {features.map((item) => (
              <li key={item} className="glass flex items-center gap-2.5 rounded-xl px-3.5 py-2.5">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                  <IconCheck size={12} />
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="surface-panel relative overflow-hidden p-6 shadow-lift">
          <div className="absolute -right-12 -top-12 h-44 w-44 rounded-full bg-brand-500/20 blur-3xl" />
          <div className="absolute -bottom-16 -left-10 h-40 w-40 rounded-full bg-indigo-500/15 blur-3xl" />
          <div className="relative space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <LogoMark className="h-8 w-8 text-xs" />
                <p className="font-display font-semibold">Live class preview</p>
              </div>
              <Badge tone="success" pulse>
                In session
              </Badge>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="video-tile col-span-2 aspect-video bg-gradient-to-br from-brand-900/90 via-ink-950 to-indigo-950 p-4">
                <p className="text-2xs font-medium uppercase tracking-wider text-slate-400">Teacher</p>
                <p className="mt-8 font-display text-2xl font-semibold">Alex Rivera</p>
                <p className="text-sm text-slate-400">Screen + camera</p>
              </div>
              {['Maya', 'Jordan', 'Sam', 'Priya'].map((n, i) => (
                <div key={n} className="video-tile aspect-square p-3">
                  <div className="flex h-full flex-col justify-between">
                    <p className="text-xs font-medium text-slate-200">{n}</p>
                    <span className={i < 2 ? 'chip-sample' : 'chip-local'}>
                      {i < 2 ? 'In sample' : 'Local only'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs leading-relaxed text-slate-500">
              Default sample size:{' '}
              <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-brand-300">
                MAX_VISIBLE_STUDENT_VIDEOS=10
              </code>
              . Non-sampled cameras never leave the student device.
            </p>
          </div>
        </div>
      </section>

      <footer className="mt-16 border-t border-white/5 pt-6 text-center text-xs text-slate-500">
        Open-source stack · No recording · Privacy-minded selective video
      </footer>
    </main>
  );
}
