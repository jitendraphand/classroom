import { customAlphabet } from 'nanoid';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const gen = customAlphabet(alphabet, 6);

export function generateRoomCode() {
  return gen();
}

export function generateSessionToken() {
  return customAlphabet(alphabet + alphabet.toLowerCase() + '0123456789', 32)();
}

export function generateIdentity(role: 'teacher' | 'student', id: string) {
  return `${role}_${id}`;
}
