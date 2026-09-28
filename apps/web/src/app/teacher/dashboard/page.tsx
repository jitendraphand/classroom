'use client';

import Link from 'next/link';
import { claimTeacherTab } from '@/lib/classroomClient';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { PageLoading } from '@/components/ui/Skeleton';

type Me = { role: string; name?: string; email?: string; permanentCode?: string };

export default function TeacherDashboard() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState('Live Class');
  const [maxVisible, setMaxVisible] = useState(6);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{
    code: string;
    joinUrl: string;
    teacherUrl: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/auth/act-as', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'clear' }),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => {
        if (data.role !== 'teacher') router.replace('/login');
        else setMe(data);
      });
  }, [router]);

  async function startClass(e: React.FormEvent) {
    e.preventDefault();
    setStarting(true);
    setError('');
    const res = await fetch('/api/rooms/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, maxVisibleVideos: maxVisible }),
    });
    const data = await res.json();
    setStarting(false);
    if (!res.ok) {
      setError(data.error || 'Failed to start class');
      return;
    }
    setCreated(data);
    if (me && data.code) {
      setMe({ ...me, permanentCode: data.code });
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/');
  }

  async function copyLink() {
    if (!created) return;
    await navigator.clipboard.writeText(created.joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function copyCode() {
    const code = created?.code || me?.permanentCode;
    if (!code) return;
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!me) return <PageLoading label="Loading dashboard…" />;

  const displayCode = created?.code || me.permanentCode;

  return (
    <main className="page-shell max-w-3xl">
      <AppHeader
        compact
        subtitle="Teacher dashboard"
        right={
          <Button variant="secondary" onClick={logout}>
            Log out
          </Button>
        }
      />

      <div className="mb-8">
        <p className="text-sm text-slate-400">Signed in as</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight">{me.name}</h1>
        <p className="text-sm text-slate-400">{me.email}</p>
      </div>

      {displayCode && (
        <Card className="mb-6">
          <CardHeader
            title="Your permanent class code"
            subtitle="Students always join with this code. Start class anytime — the same room code is reused."
          />
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-display text-3xl font-bold tracking-[0.28em] text-brand-300">
              {displayCode}
            </p>
            <Button variant="secondary" size="sm" onClick={copyCode}>
              {copied ? 'Copied!' : 'Copy code'}
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Start class"
          subtitle="Opens (or reactivates) your permanent classroom. Students wait in the lobby until you admit them."
        />
        <form onSubmit={startClass} className="space-y-4">
          <Input
            label="Class name"
            name="className"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Input
            label="Max visible student videos"
            type="number"
            name="maxVisible"
            min={1}
            max={6}
            value={maxVisible}
            onChange={(e) => setMaxVisible(Number(e.target.value))}
            hint="Only this many student camera streams reach you. Others stay local-only on their devices."
          />
          {error && (
            <p className="text-sm text-danger-fg" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" fullWidth className="py-3" disabled={starting}>
            {starting ? 'Starting…' : 'Start class'}
          </Button>
        </form>

        {created && (
          <div className="mt-8 rounded-2xl border border-brand-500/30 bg-brand-500/10 p-5">
            <div className="flex items-center gap-2">
              <Badge tone="success" pulse>
                Room ready
              </Badge>
            </div>
            <p className="mt-3 font-display text-3xl font-bold tracking-[0.28em] text-brand-300">
              {created.code}
            </p>
            <p className="mt-3 break-all text-xs text-slate-400">Join link: {created.joinUrl}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href={created.teacherUrl}
                className="btn-primary"
                onClick={() => {
                  if (created?.code) void claimTeacherTab(created.code);
                }}
              >
                Open teacher lobby
              </Link>
              <Button variant="secondary" onClick={copyLink}>
                {copied ? 'Copied!' : 'Copy join link'}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </main>
  );
}
