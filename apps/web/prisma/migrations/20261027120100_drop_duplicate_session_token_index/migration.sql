-- "Participant_sessionToken_key" (UNIQUE) already indexes sessionToken; this
-- second index only cost write time and space.
DROP INDEX IF EXISTS "Participant_sessionToken_idx";
