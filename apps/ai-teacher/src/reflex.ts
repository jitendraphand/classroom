/**
 * System 1: the fast, rule-based layer of the AI teacher.
 *
 * Every classroom event goes through here first, in microseconds and without
 * a model: chat is triaged (question, poll answer, greeting, unsafe, spam),
 * raised hands are queued fairly, polls are tallied, the admission policy is
 * applied, and safety concerns are escalated to the human supervisor at once.
 * The reasoning layer (System 2, the LLM) gets a compact digest of what
 * changed instead of a raw event stream, and student text in it is always
 * marked as data, never as instructions.
 *
 * Pure (no network, no clock reads except through `now`): unit-tested.
 */

export type ChatIn = { id: string; from: string; fromName: string; role: string; text: string; private: boolean; at: number };

export type Triage = 'question' | 'answer' | 'greeting' | 'unsafe' | 'spam' | 'other';

export type Policy = {
  /** roster: admit students who came with the school app's signed link; manual: leave to the teacher; all: admit everyone. */
  admit: 'roster' | 'manual' | 'all';
  /** Chat messages a student may send per minute before the rest count as spam. */
  chatPerMinute: number;
};

export const DEFAULT_POLICY: Policy = { admit: 'roster', chatPerMinute: 6 };

/**
 * Phrases that need an adult now. Deliberately broad: a false alarm costs
 * the supervisor a glance, a miss costs far more. Word forms included
 * ("hits me", "bullied").
 */
const UNSAFE: RegExp[] = [
  /\bkill(s|ing)? (myself|me)\b/, /\bsuicid/, /\bself[- ]?harm/, /\b(cut|cutting|hurt|hurting) myself\b/, /\bwants? to die\b/,
  /\babus(e|ed|es|ing)\b/, /\b(touch|touches|touched|touching) me\b/, /\b(hit|hits|hitting|beat|beats|beating|slap|slaps|slapped|kick|kicks|kicked) me\b/,
  /\bbull(y|ies|ied|ying)\b/, /\bthreat/, /\bguns?\b/, /\bknife\b/, /\bbomb/, /\bnudes?\b/, /\bsex/,
];
const GREETING = /^(hi|hello|hey|good (morning|afternoon|evening)|namaste|thanks|thank you|ok|okay|yes|no)\b[\s!.]*$/i;
const QUESTION = /\?|^(what|why|how|when|where|who|which|can|could|is|are|do|does|did|will|should|would|explain|i don'?t (get|understand)|doubt)\b/i;
const PHONE = /(?:\+?\d[\s-]?){9,}/;

export type Poll = { id: string; question: string; options: string[]; openUntil: number; votes: Map<string, number> };

export type Escalation = { at: number; from: string; fromName: string; reason: string; text: string };

export type Digest = {
  /** Questions from students since the last digest (text is untrusted data). */
  questions: { from: string; name: string; text: string; private: boolean }[];
  /** Other notable chat (not greetings, spam or poll answers). */
  chat: { from: string; name: string; text: string }[];
  hands: { id: string; name: string; waitingSec: number }[];
  /** Hand to take next (least recently spoken, then longest waiting). */
  nextHand: string | null;
  poll: { question: string; options: string[]; counts: number[]; voters: number; open: boolean } | null;
  joined: string[];
  left: string[];
  waiting: { id: string; name: string; signed: boolean }[];
  escalations: Escalation[];
  greetings: number;
  spamDropped: number;
};

export function triage(text: string): Exclude<Triage, 'spam' | 'answer'> {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (UNSAFE.some((re) => re.test(lower)) || PHONE.test(t)) return 'unsafe';
  if (GREETING.test(t)) return 'greeting';
  if (QUESTION.test(t)) return 'question';
  return 'other';
}

/** "B", "b)", "option 2", "2" -> option index for a poll with n options; null otherwise. */
export function pollAnswer(text: string, n: number): number | null {
  const t = text.trim().toLowerCase().replace(/^option\s*/, '').replace(/[).:\s]+$/, '');
  if (/^[a-z]$/.test(t)) {
    const i = t.charCodeAt(0) - 97;
    return i < n ? i : null;
  }
  if (/^\d{1,2}$/.test(t)) {
    const i = Number(t) - 1;
    return i >= 0 && i < n ? i : null;
  }
  return null;
}

/** Truncate and strip control characters: student text goes to the LLM as data. */
export function quoteable(text: string, max = 280): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export class Reflex {
  private q: Digest['questions'] = [];
  private chat: Digest['chat'] = [];
  private greetings = 0;
  private spam = 0;
  private escalationsPending: Escalation[] = [];
  readonly escalationLog: Escalation[] = [];
  private recent = new Map<string, number[]>();
  private hands = new Map<string, { name: string; since: number }>();
  private lastSpoke = new Map<string, number>();
  private joined: string[] = [];
  private left: string[] = [];
  private waiting = new Map<string, { name: string; signed: boolean }>();
  poll: Poll | null = null;

  constructor(readonly policy: Policy = DEFAULT_POLICY) {}

  /** A chat message. Returns what System 1 did with it. */
  onChat(m: ChatIn, now: number): Triage {
    if (m.role !== 'STUDENT') return 'other';
    const times = (this.recent.get(m.from) ?? []).filter((t) => now - t < 60_000);
    times.push(now);
    this.recent.set(m.from, times);
    if (times.length > this.policy.chatPerMinute) {
      this.spam++;
      return 'spam';
    }
    if (this.poll && now <= this.poll.openUntil) {
      const a = pollAnswer(m.text, this.poll.options.length);
      if (a !== null) {
        this.poll.votes.set(m.from, a); // the latest answer counts
        return 'answer';
      }
    }
    const kind = triage(m.text);
    const text = quoteable(m.text);
    if (kind === 'unsafe') {
      const e = { at: now, from: m.from, fromName: m.fromName, reason: PHONE.test(m.text) ? 'personal contact details' : 'possible safety concern', text };
      this.escalationsPending.push(e);
      this.escalationLog.push(e);
    } else if (kind === 'greeting') this.greetings++;
    else if (kind === 'question') this.q.push({ from: m.from, name: m.fromName, text, private: m.private });
    else this.chat.push({ from: m.from, name: m.fromName, text });
    return kind;
  }

  onHand(id: string, name: string, raised: boolean, now: number): void {
    if (raised && !this.hands.has(id)) this.hands.set(id, { name, since: now });
    if (!raised) this.hands.delete(id);
  }

  /** The student was given the floor (unmuted to speak). */
  onSpoke(id: string, now: number): void {
    this.lastSpoke.set(id, now);
    this.hands.delete(id);
  }

  onJoin(name: string): void {
    this.joined.push(name);
  }

  onLeave(id: string, name: string): void {
    this.left.push(name);
    this.hands.delete(id);
  }

  /**
   * The waiting list changed. Returns the ids to admit now under the policy
   * (roster: only students who arrived with the school app's signed link).
   */
  onWaiting(list: { id: string; name: string; signed: boolean }[]): string[] {
    this.waiting = new Map(list.map((w) => [w.id, { name: w.name, signed: w.signed }]));
    if (this.policy.admit === 'all') return list.map((w) => w.id);
    if (this.policy.admit === 'roster') return list.filter((w) => w.signed).map((w) => w.id);
    return [];
  }

  openPoll(id: string, question: string, options: string[], seconds: number, now: number): Poll {
    this.poll = { id, question, options, openUntil: now + seconds * 1000, votes: new Map() };
    return this.poll;
  }

  pollResult(now: number): Digest['poll'] {
    if (!this.poll) return null;
    const counts = this.poll.options.map(() => 0);
    for (const v of this.poll.votes.values()) counts[v]!++;
    return { question: this.poll.question, options: this.poll.options, counts, voters: this.poll.votes.size, open: now <= this.poll.openUntil };
  }

  /** Least recently spoken first, then longest waiting. */
  nextHand(): string | null {
    let best: string | null = null;
    let key: [number, number] | null = null;
    for (const [id, h] of this.hands) {
      const k: [number, number] = [this.lastSpoke.get(id) ?? 0, h.since];
      if (!key || k[0] < key[0] || (k[0] === key[0] && k[1] < key[1])) {
        best = id;
        key = k;
      }
    }
    return best;
  }

  /** True when there is something for the reasoning layer to look at. */
  pending(): boolean {
    return this.q.length > 0 || this.chat.length > 0 || this.escalationsPending.length > 0 || this.joined.length > 0 || this.left.length > 0;
  }

  /** What changed since the last digest; resets the per-digest lists. */
  digest(now: number): Digest {
    const d: Digest = {
      questions: this.q,
      chat: this.chat.slice(-10),
      hands: [...this.hands].map(([id, h]) => ({ id, name: h.name, waitingSec: Math.round((now - h.since) / 1000) })),
      nextHand: this.nextHand(),
      poll: this.pollResult(now),
      joined: this.joined,
      left: this.left,
      waiting: [...this.waiting].map(([id, w]) => ({ id, name: w.name, signed: w.signed })),
      escalations: this.escalationsPending,
      greetings: this.greetings,
      spamDropped: this.spam,
    };
    this.q = [];
    this.chat = [];
    this.joined = [];
    this.left = [];
    this.escalationsPending = [];
    this.greetings = 0;
    this.spam = 0;
    return d;
  }
}

/**
 * Splits streamed text into speakable chunks for text-to-speech: a sentence
 * as soon as it ends, or a clause once it is long, so the first words are
 * spoken while the rest is still being written.
 */
export class SpeechChunker {
  private buf = '';
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const m = /^(.+?[.!?।]+["')\]]*)(\s+|$)/s.exec(this.buf);
      if (m && (m[2] || this.buf.length > m[1]!.length)) {
        out.push(m[1]!.trim());
        this.buf = this.buf.slice(m[0].length);
        continue;
      }
      if (this.buf.length > 160) {
        const cut = Math.max(this.buf.lastIndexOf(', ', 160), this.buf.lastIndexOf('; ', 160), this.buf.lastIndexOf(' ', 160));
        if (cut > 40) {
          out.push(this.buf.slice(0, cut + 1).trim());
          this.buf = this.buf.slice(cut + 1);
          continue;
        }
      }
      break;
    }
    return out.filter(Boolean);
  }
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }
}
