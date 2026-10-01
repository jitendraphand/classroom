-- CreateEnum
CREATE TYPE "OverrideKind" AS ENUM ('CANCEL', 'MODIFY', 'EXTRA');

-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "classSessionId" TEXT;

-- CreateTable
CREATE TABLE "TimetableSlot" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "divisions" TEXT[],
    "allDivisions" BOOLEAN NOT NULL DEFAULT false,
    "subject" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "effectiveFrom" DATE,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimetableSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleOverride" (
    "id" TEXT NOT NULL,
    "kind" "OverrideKind" NOT NULL,
    "date" DATE NOT NULL,
    "slotId" TEXT,
    "teacherId" TEXT,
    "grade" TEXT,
    "divisions" TEXT[],
    "allDivisions" BOOLEAN NOT NULL DEFAULT false,
    "subject" TEXT,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassSession" (
    "id" TEXT NOT NULL,
    "occurrenceKey" TEXT,
    "slotId" TEXT,
    "overrideId" TEXT,
    "sessionDate" DATE NOT NULL,
    "teacherId" TEXT NOT NULL,
    "roomId" TEXT,
    "grade" TEXT NOT NULL,
    "divisions" TEXT[],
    "allDivisions" BOOLEAN NOT NULL DEFAULT false,
    "subject" TEXT NOT NULL,
    "adHoc" BOOLEAN NOT NULL DEFAULT false,
    "scheduledStart" TIMESTAMP(3),
    "scheduledEnd" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimetableSlot_teacherId_weekday_idx" ON "TimetableSlot"("teacherId", "weekday");

-- CreateIndex
CREATE INDEX "TimetableSlot_grade_weekday_idx" ON "TimetableSlot"("grade", "weekday");

-- CreateIndex
CREATE INDEX "ScheduleOverride_date_idx" ON "ScheduleOverride"("date");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleOverride_slotId_date_key" ON "ScheduleOverride"("slotId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ClassSession_occurrenceKey_key" ON "ClassSession"("occurrenceKey");

-- CreateIndex
CREATE INDEX "ClassSession_teacherId_sessionDate_idx" ON "ClassSession"("teacherId", "sessionDate");

-- CreateIndex
CREATE INDEX "ClassSession_grade_sessionDate_idx" ON "ClassSession"("grade", "sessionDate");

-- CreateIndex
CREATE INDEX "ClassSession_sessionDate_idx" ON "ClassSession"("sessionDate");

-- AddForeignKey
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleOverride" ADD CONSTRAINT "ScheduleOverride_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "TimetableSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleOverride" ADD CONSTRAINT "ScheduleOverride_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassSession" ADD CONSTRAINT "ClassSession_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "TimetableSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassSession" ADD CONSTRAINT "ClassSession_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassSession" ADD CONSTRAINT "ClassSession_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

