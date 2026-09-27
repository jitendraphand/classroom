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
  'Permanent teacher room codes',
];

export default function HomePage() {
  return (
    <main className="light-landing min-h-screen">
      <div className="page-shell flex flex-col">
        <AppHeader
          right={
            <>
              <Link href="/login" className="landing-btn-secondary">
                Teacher login
              </Link>
              <Link href="/register" className="landing-btn-primary">
                Get started
              </Link>
            </>
          }
        />

        <section className="mt-8 grid flex-1 gap-12 lg:mt-14 lg:grid-cols-2 lg:items-center">
          <div>
            <Badge tone="brand" className="mb-4 !bg-brand-50 !text-brand-700 !border-brand-200">
              Live teaching · Privacy-minded
            </Badge>
            <h1 className="font-display text-4xl font-semibold leading-[1.1] tracking-tight text-slate-900 sm:text-5xl">
              Teach live classes without streaming every student camera.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-600">
              Students join with your permanent room code — no accounts. Admit from a waiting room.
              Only a rotating sample of student videos reaches you; everyone else stays local-only
              while still feeling present.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/register" className="landing-btn-primary px-6 py-3 text-base">
                Create teacher account
              </Link>
              <Link href="/join" className="landing-btn-secondary px-6 py-3 text-base">
                Join as student
              </Link>
            </div>
            <ul className="mt-10 grid gap-2.5 text-sm text-slate-700 sm:grid-cols-2">
              {features.map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-2.5 rounded-xl border border-slate-200/80 bg-white px-3.5 py-2.5 shadow-sm"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                    <IconCheck size={12} />
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-6 shadow-lg shadow-slate-200/60">
            <div className="absolute -right-12 -top-12 h-44 w-44 rounded-full bg-brand-100/80 blur-3xl" />
            <div className="absolute -bottom-16 -left-10 h-40 w-40 rounded-full bg-sky-100/70 blur-3xl" />
            <div className="relative space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <LogoMark className="h-8 w-8 text-xs" />
                  <p className="font-display font-semibold text-slate-900">Live class preview</p>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-2xs font-semibold text-emerald-700">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                  In session
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 aspect-video rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 via-brand-50 to-sky-50 p-4">
                  <p className="text-2xs font-medium uppercase tracking-wider text-slate-500">
                    Teacher
                  </p>
                  <p className="mt-8 font-display text-2xl font-semibold text-slate-900">
                    Alex Rivera
                  </p>
                  <p className="text-sm text-slate-500">Screen + camera</p>
                </div>
                {['Maya', 'Jordan', 'Sam', 'Priya'].map((n, i) => (
                  <div
                    key={n}
                    className="aspect-square rounded-xl border border-slate-200 bg-slate-50 p-3"
                  >
                    <div className="flex h-full flex-col justify-between">
                      <p className="text-xs font-medium text-slate-800">{n}</p>
                      <span
                        className={
                          i < 2
                            ? 'inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-2xs font-semibold text-emerald-700'
                            : 'inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-2xs font-semibold text-slate-500'
                        }
                      >
                        {i < 2 ? 'In sample' : 'Local only'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs leading-relaxed text-slate-500">
                Your permanent code stays the same every session. Non-sampled cameras never leave the
                student device.
              </p>
            </div>
          </div>
        </section>

        <footer className="mt-16 border-t border-slate-200 pt-6 text-center text-xs text-slate-500">
          Open-source stack · No recording · Privacy-minded selective video
        </footer>
      </div>
    </main>
  );
}
