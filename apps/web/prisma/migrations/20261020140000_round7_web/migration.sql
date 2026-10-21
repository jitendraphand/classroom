-- Round 7: roles, academic year, class feedback, teacher rank snapshots, school limits.
-- Additive only. Existing rows are backfilled; nothing is dropped.

CREATE TYPE "AdminKind" AS ENUM ('SYSTEM', 'SUB');

ALTER TABLE "Admin" ADD COLUMN "kind" "AdminKind" NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE "Admin" ADD COLUMN "privManageTeachers" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Admin" ADD COLUMN "privSchedule" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Admin" ADD COLUMN "privMonitorLive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Admin" ADD COLUMN "privViewReports" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Admin" ADD COLUMN "privManageSchool" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "TimetableSlot" ADD COLUMN "academicYear" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ScheduleOverride" ADD COLUMN "academicYear" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ClassSession" ADD COLUMN "academicYear" TEXT NOT NULL DEFAULT '';

-- India-style academic year (June–May). June 2026 → 2026-27, May 2026 → 2025-26.
-- Applied in the school’s stored dates (date columns are timezone-free calendar dates).

UPDATE "TimetableSlot"
SET "academicYear" = CASE
  WHEN EXTRACT(MONTH FROM COALESCE("effectiveFrom", ("createdAt" AT TIME ZONE 'UTC')::date)) >= 6 THEN
    EXTRACT(YEAR FROM COALESCE("effectiveFrom", ("createdAt" AT TIME ZONE 'UTC')::date))::int::text
      || '-' || lpad(((EXTRACT(YEAR FROM COALESCE("effectiveFrom", ("createdAt" AT TIME ZONE 'UTC')::date))::int + 1) % 100)::text, 2, '0')
  ELSE
    (EXTRACT(YEAR FROM COALESCE("effectiveFrom", ("createdAt" AT TIME ZONE 'UTC')::date))::int - 1)::text
      || '-' || lpad((EXTRACT(YEAR FROM COALESCE("effectiveFrom", ("createdAt" AT TIME ZONE 'UTC')::date))::int % 100)::text, 2, '0')
END
WHERE "academicYear" = '';

UPDATE "ScheduleOverride"
SET "academicYear" = CASE
  WHEN EXTRACT(MONTH FROM "date") >= 6 THEN
    EXTRACT(YEAR FROM "date")::int::text || '-' || lpad(((EXTRACT(YEAR FROM "date")::int + 1) % 100)::text, 2, '0')
  ELSE
    (EXTRACT(YEAR FROM "date")::int - 1)::text || '-' || lpad((EXTRACT(YEAR FROM "date")::int % 100)::text, 2, '0')
END
WHERE "academicYear" = '';

UPDATE "ClassSession"
SET "academicYear" = CASE
  WHEN EXTRACT(MONTH FROM "sessionDate") >= 6 THEN
    EXTRACT(YEAR FROM "sessionDate")::int::text || '-' || lpad(((EXTRACT(YEAR FROM "sessionDate")::int + 1) % 100)::text, 2, '0')
  ELSE
    (EXTRACT(YEAR FROM "sessionDate")::int - 1)::text || '-' || lpad((EXTRACT(YEAR FROM "sessionDate")::int % 100)::text, 2, '0')
END
WHERE "academicYear" = '';

CREATE INDEX "TimetableSlot_academicYear_idx" ON "TimetableSlot"("academicYear");
CREATE INDEX "ScheduleOverride_academicYear_idx" ON "ScheduleOverride"("academicYear");
CREATE INDEX "ClassSession_academicYear_idx" ON "ClassSession"("academicYear");

CREATE TABLE "ClassFeedback" (
    "id" TEXT NOT NULL,
    "classSessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "stars" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClassFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClassFeedback_classSessionId_studentId_key" ON "ClassFeedback"("classSessionId", "studentId");
CREATE INDEX "ClassFeedback_studentId_idx" ON "ClassFeedback"("studentId");
CREATE INDEX "ClassFeedback_classSessionId_idx" ON "ClassFeedback"("classSessionId");

ALTER TABLE "ClassFeedback"
  ADD CONSTRAINT "ClassFeedback_classSessionId_fkey"
  FOREIGN KEY ("classSessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClassFeedback"
  ADD CONSTRAINT "ClassFeedback_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TeacherRankSnapshot" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "percentile" DOUBLE PRECISION,
    "bayesianAvg" DOUBLE PRECISION NOT NULL,
    "rawAvg" DOUBLE PRECISION,
    "ratingCount" INTEGER NOT NULL,
    "eligible" BOOLEAN NOT NULL DEFAULT false,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeacherRankSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeacherRankSnapshot_teacherId_academicYear_weekStart_key"
  ON "TeacherRankSnapshot"("teacherId", "academicYear", "weekStart");
CREATE INDEX "TeacherRankSnapshot_academicYear_weekStart_idx"
  ON "TeacherRankSnapshot"("academicYear", "weekStart");

ALTER TABLE "TeacherRankSnapshot"
  ADD CONSTRAINT "TeacherRankSnapshot_teacherId_fkey"
  FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AcademicYear" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AcademicYear_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AcademicYear_label_key" ON "AcademicYear"("label");

INSERT INTO "AcademicYear" ("id", "label", "active", "createdAt", "updatedAt")
SELECT 'ay_' || y.label, y.label, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT "academicYear" AS label FROM "TimetableSlot" WHERE "academicYear" <> ''
  UNION
  SELECT "academicYear" FROM "ScheduleOverride" WHERE "academicYear" <> ''
  UNION
  SELECT "academicYear" FROM "ClassSession" WHERE "academicYear" <> ''
) y
ON CONFLICT ("label") DO NOTHING;

CREATE TABLE "SchoolSetting" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "maxOpenStudentMics" INTEGER NOT NULL DEFAULT 0,
    "maxStudentsPerClass" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SchoolSetting_pkey" PRIMARY KEY ("id")
);

INSERT INTO "SchoolSetting" ("id", "maxOpenStudentMics", "maxStudentsPerClass", "updatedAt")
VALUES ('default', 0, NULL, CURRENT_TIMESTAMP);
