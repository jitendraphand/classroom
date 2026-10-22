'use client';

import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { FeedbackForm } from './FeedbackForm';
import { classEndedCopy, finishFromState } from '@/lib/classFinish';
import { classEndedNoted, noteClassEnded } from '@/lib/classEnded';
import { roomFetch } from '@/lib/classroomClient';

type Props = { code: string; children: ReactNode };
type Phase = 'checking' | 'ended' | 'failed';
type State = { error: boolean; phase: Phase; school: boolean };

/**
 * A render crash in the classroom used to become Next's
 * "Application error: client-side exception". If the class has ended, show
 * that page (and feedback for a school student). Otherwise a calm retry.
 */
export class ClassroomGuard extends Component<Props, State> {
  state: State = { error: false, phase: 'checking', school: false };

  static getDerivedStateFromError(): Partial<State> {
    return { error: true, phase: 'checking' };
  }

  componentDidCatch() {
    if (classEndedNoted(this.props.code)) {
      this.setState({ phase: 'ended' });
      void this.checkSchool();
      return;
    }
    void this.probe();
  }

  checkSchool = async () => {
    try {
      const ok = (await fetch('/api/student/check', { cache: 'no-store' })).ok;
      if (ok) this.setState({ school: true });
    } catch {
      /* guest */
    }
  };

  probe = async () => {
    const code = this.props.code;
    try {
      const res = await roomFetch(code, '/state');
      const body = (await res.json().catch(() => null)) as { status?: string; ended?: boolean } | null;
      const ended = res.status === 410 || finishFromState(body) === 'ended' || classEndedNoted(code);
      if (ended) {
        noteClassEnded(code);
        this.setState({ phase: 'ended' });
        void this.checkSchool();
        return;
      }
    } catch {
      /* show the calm failure below */
    }
    this.setState({ phase: 'failed' });
  };

  render() {
    if (!this.state.error) return this.props.children;
    if (this.state.phase === 'checking') {
      return (
        <main className="flex min-h-screen items-center justify-center px-6 text-sm text-slate-300">
          Checking the class…
        </main>
      );
    }
    if (this.state.phase === 'ended') {
      const copy = classEndedCopy(false);
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6" data-finished="ended">
          <div className="max-w-md rounded-2xl border border-white/10 bg-surface-1 p-8 text-center shadow-lift">
            <p className="font-display text-2xl font-semibold tracking-tight">{copy.title}</p>
            <p className="mt-2 text-sm text-slate-400">{copy.body}</p>
            {this.state.school && (
              <div className="mt-6 text-left">
                <FeedbackForm code={this.props.code} onDone={() => this.setState({ school: false })} />
              </div>
            )}
          </div>
        </main>
      );
    }
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
        <p className="text-sm text-slate-300">Something went wrong in the classroom</p>
        <Button
          variant="secondary"
          onClick={() => this.setState({ error: false, phase: 'checking', school: false })}
        >
          Try again
        </Button>
      </main>
    );
  }
}
