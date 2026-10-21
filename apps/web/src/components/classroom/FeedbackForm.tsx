'use client';

import { useState } from 'react';
import { roomFetch } from '@/lib/classroomClient';
import { FEEDBACK_MAX_COMMENT, feedbackProblem, normalizeFeedbackComment } from '@/lib/feedbackText';

/** End-of-class rating. Skip leaves without a request. */
export function FeedbackForm({ code, onDone }: { code: string; onDone: () => void }) {
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = feedbackProblem(stars, comment);
    if (problem) {
      setError(problem);
      return;
    }
    const normalized = normalizeFeedbackComment(comment);
    setBusy(true);
    setError('');
    try {
      const res = await roomFetch(code, '/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stars, comment: normalized }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          res.status === 409
            ? 'You already sent feedback for this class'
            : data.error || 'Could not send feedback'
        );
        setBusy(false);
        return;
      }
      onDone();
    } catch {
      setError('Network error');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-3 text-left" data-testid="feedback-form">
      <p className="text-center text-sm font-semibold text-slate-200">How was class?</p>
      <div className="flex justify-center gap-1" role="group" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
            aria-pressed={stars >= n}
            className={`px-1 text-2xl leading-none ${n <= stars ? 'text-amber-300' : 'text-slate-500'}`}
            onClick={() => setStars(n)}
          >
            ★
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        maxLength={FEEDBACK_MAX_COMMENT}
        rows={2}
        placeholder="Optional comment"
        aria-label="Comment"
        className="w-full resize-none rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-white outline-none placeholder:text-slate-500"
        onChange={(e) => setComment(e.target.value.slice(0, FEEDBACK_MAX_COMMENT))}
      />
      {error && (
        <p
          className="rounded-lg border border-red-400/40 bg-red-500/15 px-2 py-1.5 text-center text-sm text-red-100"
          role="alert"
          data-testid="feedback-error"
        >
          {error}
        </p>
      )}
      <div className="flex justify-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          Send
        </button>
        <button type="button" className="rounded-lg px-3 py-1.5 text-sm text-slate-300 hover:text-white" onClick={onDone}>
          Skip
        </button>
      </div>
    </form>
  );
}
