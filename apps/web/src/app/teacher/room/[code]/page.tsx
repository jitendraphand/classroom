'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageLoading } from '@/components/ui/Skeleton';
import { IconUsers } from '@/components/ui/Icons';

type Waiting = { id: string; displayName: string; createdAt: string };
type State = {
  name: string;
  code: string;
  status: string;
  maxVisibleVideos: number;
  waiting?: Waiting[];
  admitted?: { id: string; displayName: string; role: string }[];
  isTeacher?: boolean;
};

export default function TeacherRoomLobby() {
  const params = useParams();
  const router = useRouter();
  const code = String(params.code || '').toUpperCase();
  const [state, setState] = useState<State | null>(null);
  const [maxVisible, setMaxVisible] = useState(10);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const poll = useCallback(async () => {
    const res = await fetch(`/api/rooms/${code}/state`);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || 'Failed to load room');
      return;
    }
    if (!data.isTeacher) {
      router.replace('/login');
      return;
    }
    setState(data);
    setMaxVisible(data.maxVisibleVideos);
  }, [code, router]);

  useEffect(() => {
    fetch('/api/auth/act-as', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'clear' }),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [poll]);

  async function admit(ids?: string[], all?: boolean) {
    setBusy(true);
    await fetch(`/api/rooms/${code}/admit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(all ? { all: true } : { participantIds: ids }),
    });
    setBusy(false);
    poll();
  }

  async function saveSettings() {
    setBusy(true);
    await fetch(`/api/rooms/${code}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxVisibleVideos: maxVisible }),
    });
    setBusy(false);
    poll();
  }

  async function endClass() {
    if (!confirm('End class for everyone?')) return;
    await fetch(`/api/rooms/${code}/end`, { method: 'POST' });
    router.push('/teacher/dashboard');
  }

  async function copyLink(joinUrl: string) {
    await navigator.clipboard.writeText(joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!state) {
    return <PageLoading label={error || 'Loading lobby…'} />;
  }

  const joinUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/join/${code}` : `/join/${code}`;
  const studentCount = state.admitted?.filter((a) => a.role === 'STUDENT').length || 0;

  return (
    <main className="page-shell max-w-4xl">
      <AppHeader
        compact
        subtitle="Teacher lobby"
        right={
          <>
            <Button variant="secondary" onClick={() => copyLink(joinUrl)}>
              {copied ? 'Copied!' : 'Copy link'}
            </Button>
            <Link href={`/classroom/${code}`} className="btn-primary">
              Enter classroom
            </Link>
            <Button variant="danger" onClick={endClass}>
              End class
            </Button>
          </>
        }
      />

      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={state.status === 'LIVE' || state.status === 'ACTIVE' ? 'success' : 'brand'} pulse>
            {state.status}
          </Badge>
          <Badge tone="neutral">{code}</Badge>
        </div>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">{state.name}</h1>
        <p className="mt-2 break-all text-xs text-slate-500">Share: {joinUrl}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card padding={false} className="p-6">
          <CardHeader
            title="Waiting room"
            action={<Badge tone="neutral">{state.waiting?.length || 0}</Badge>}
          />
          {(state.waiting?.length || 0) === 0 ? (
            <EmptyState
              icon={<IconUsers size={28} />}
              title="No students waiting"
              description="Share the join link. People who enter will appear here until you admit them."
              className="py-8"
            />
          ) : (
            <ul className="space-y-2">
              {state.waiting!.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.05] bg-black/20 px-3 py-2.5"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Avatar name={p.displayName} size="sm" />
                    <span className="truncate font-medium">{p.displayName}</span>
                  </div>
                  <Button size="sm" disabled={busy} onClick={() => admit([p.id])}>
                    Admit
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {(state.waiting?.length || 0) > 0 && (
            <Button
              variant="secondary"
              fullWidth
              className="mt-4"
              disabled={busy}
              onClick={() => admit(undefined, true)}
            >
              Admit all
            </Button>
          )}
        </Card>

        <Card padding={false} className="space-y-6 p-6">
          <div>
            <CardHeader title="In class" />
            <p className="text-sm text-slate-400">
              {studentCount} student{studentCount === 1 ? '' : 's'} admitted
            </p>
            <ul className="mt-3 max-h-44 space-y-1.5 overflow-y-auto text-sm">
              {state.admitted?.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-white/[0.04]"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar name={p.displayName} size="sm" />
                    <span className="truncate">{p.displayName}</span>
                  </div>
                  <span className="text-2xs text-slate-500">
                    {p.role === 'TEACHER' ? 'Teacher' : 'Student'}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="border-t border-white/5 pt-5">
            <h3 className="text-sm font-semibold text-slate-200">Visible student video sample</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              The server randomly selects this many students to publish camera tracks. Others keep a
              local preview only.
            </p>
            <div className="mt-3 flex gap-2">
              <Input
                type="number"
                min={1}
                max={50}
                value={maxVisible}
                onChange={(e) => setMaxVisible(Number(e.target.value))}
                aria-label="Max visible student videos"
              />
              <Button variant="secondary" disabled={busy} onClick={saveSettings}>
                Save
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}
