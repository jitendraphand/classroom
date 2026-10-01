import { randomInt } from 'node:crypto';

/** No 0/O/1/l/I so a password read off a screen is typed correctly. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Strong random password (default 20 chars ≈ 116 bits), grouped for readability. */
export function generatePassword(length = 20): string {
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s.replace(/(.{5})(?=.)/g, '$1-');
}

export const MIN_PASSWORD_LENGTH = 10;

/** Returns an error message, or null when the new password is acceptable. */
export function passwordProblem(pw: string, opts: { email?: string; current?: string } = {}): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (pw.length > 128) return 'Password is too long.';
  if (opts.current && pw === opts.current) return 'Choose a password different from the current one.';
  if (opts.email && pw.toLowerCase().includes(opts.email.split('@')[0]!.toLowerCase()) && opts.email.split('@')[0]!.length >= 4) {
    return 'Do not include your email name in the password.';
  }
  if (/^(.)\1+$/.test(pw) || /^(password|12345)/i.test(pw)) return 'That password is too easy to guess.';
  return null;
}
