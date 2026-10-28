import { readFileSync } from 'node:fs';

/**
 * Source of the classroom view: ClassroomRoom.tsx plus the modules split out
 * of it, for the tests that check wiring by reading the source.
 */
const FILES = [
  'ClassroomRoom.tsx',
  'participantRoles.ts',
  'StudentMediaPrivacy.tsx',
  'localPublish.ts',
  'SelectivePublisher.tsx',
  'TeacherPeersFloat.tsx',
  'TeacherCameraFloat.tsx',
];

export function classroomViewSource(): string {
  return FILES.map((f) => readFileSync(new URL(`../../src/components/classroom/${f}`, import.meta.url), 'utf8')).join('\n');
}
