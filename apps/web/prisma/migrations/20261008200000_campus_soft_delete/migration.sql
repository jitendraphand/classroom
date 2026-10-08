-- Campus as a third audience criterion (campus + grade + division) and soft delete
-- for teachers / students. Clean schema, no back-compat defaults: this ships with a
-- fresh database (the Mumbai DB was wiped on 2026-10-08), so the NOT NULL campus
-- columns are added to empty tables. On a non-empty database this migration fails
-- (and the container refuses to start) instead of inventing a campus.

-- DropIndex
DROP INDEX "TeacherAssignment_grade_division_idx";

-- DropIndex
DROP INDEX "TeacherAssignment_teacherId_grade_division_key";

-- DropIndex
DROP INDEX "TimetableSlot_grade_weekday_idx";

-- DropIndex
DROP INDEX "ClassSession_grade_sessionDate_idx";

-- DropIndex
DROP INDEX "Student_grade_division_idx";

-- AlterTable
ALTER TABLE "Teacher" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TeacherAssignment" ADD COLUMN     "campus" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "TimetableSlot" ADD COLUMN     "campus" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ScheduleOverride" ADD COLUMN     "campus" TEXT;

-- AlterTable
ALTER TABLE "ClassSession" ADD COLUMN     "campus" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "campus" TEXT NOT NULL,
ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Campus" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Campus_name_key" ON "Campus"("name");

-- CreateIndex
CREATE INDEX "Campus_sortOrder_idx" ON "Campus"("sortOrder");

-- CreateIndex
CREATE INDEX "TeacherAssignment_campus_grade_division_idx" ON "TeacherAssignment"("campus", "grade", "division");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherAssignment_teacherId_campus_grade_division_key" ON "TeacherAssignment"("teacherId", "campus", "grade", "division");

-- CreateIndex
CREATE INDEX "TimetableSlot_campus_grade_weekday_idx" ON "TimetableSlot"("campus", "grade", "weekday");

-- CreateIndex
CREATE INDEX "ClassSession_campus_grade_sessionDate_idx" ON "ClassSession"("campus", "grade", "sessionDate");

-- CreateIndex
CREATE INDEX "Student_campus_grade_division_idx" ON "Student"("campus", "grade", "division");

