-- Optional gender on Teacher (male / female). Null means the admin has not
-- set it yet; student-facing pages then show the name without Sir/Ma'am.
ALTER TABLE "Teacher" ADD COLUMN "gender" TEXT;

-- The school's known teacher. Other existing rows stay unset (no guess).
UPDATE "Teacher" SET "gender" = 'male' WHERE "name" = 'Jitendra Phand' AND "deletedAt" IS NULL AND "gender" IS NULL;
