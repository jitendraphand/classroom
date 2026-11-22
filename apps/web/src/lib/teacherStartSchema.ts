import { z } from 'zod';
import { MAX_AUDIENCE_INPUT_LENGTH } from './grades';

/**
 * Body of POST /api/teacher/sessions/start: a timetabled occurrence or an
 * ad-hoc ("extra") class. Campus / grade / division accept raw text up to
 * MAX_AUDIENCE_INPUT_LENGTH; startAdHocClass normalises them to the master
 * list's canonical codes (divisions up to 32 letters, e.g. SCIENCEFOUNDATION).
 */
export const startClassSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('scheduled'),
    key: z.string().min(1).max(200),
    maxVisibleVideos: z.number().int().min(1).max(6).optional(),
  }),
  z.object({
    kind: z.literal('adhoc'),
    campus: z.string().min(1).max(MAX_AUDIENCE_INPUT_LENGTH),
    grade: z.string().min(1).max(MAX_AUDIENCE_INPUT_LENGTH),
    divisions: z.array(z.string().max(MAX_AUDIENCE_INPUT_LENGTH)).max(40).default([]),
    allDivisions: z.boolean().optional(),
    subject: z.string().max(80).optional(),
    maxVisibleVideos: z.number().int().min(1).max(6).optional(),
  }),
]);
