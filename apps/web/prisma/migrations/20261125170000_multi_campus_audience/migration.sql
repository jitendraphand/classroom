-- A timetable slot, extra class or class session may cover several campuses.
-- `campus` stays the primary campus; `campuses` lists all of them.
ALTER TABLE "TimetableSlot" ADD COLUMN "campuses" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ScheduleOverride" ADD COLUMN "campuses" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ClassSession" ADD COLUMN "campuses" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Existing rows cover their one campus.
UPDATE "TimetableSlot" SET "campuses" = ARRAY["campus"] WHERE "campus" <> '';
UPDATE "ScheduleOverride" SET "campuses" = ARRAY["campus"] WHERE "campus" IS NOT NULL AND "campus" <> '';
UPDATE "ClassSession" SET "campuses" = ARRAY["campus"] WHERE "campus" <> '';

-- GIN indexes for "student's campus in campuses" lookups.
CREATE INDEX "TimetableSlot_campuses_idx" ON "TimetableSlot" USING GIN ("campuses");
CREATE INDEX "ClassSession_campuses_idx" ON "ClassSession" USING GIN ("campuses");
