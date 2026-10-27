-- Closed / tombstoned LiveKit SIDs per attendance record (lib/attendance.ts):
-- makes join/leave application idempotent and order-tolerant.
ALTER TABLE "AttendanceRecord" ADD COLUMN "closedSids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Records created on arrival never set "openSids", so it was NULL until the
-- first connection event. The class-end "stamp leftAt where nothing is open"
-- (openSids = '{}') therefore skipped exactly the students who arrived but
-- never connected. Backfill and default to an empty array.
UPDATE "AttendanceRecord" SET "openSids" = ARRAY[]::TEXT[] WHERE "openSids" IS NULL;
ALTER TABLE "AttendanceRecord" ALTER COLUMN "openSids" SET DEFAULT ARRAY[]::TEXT[];
