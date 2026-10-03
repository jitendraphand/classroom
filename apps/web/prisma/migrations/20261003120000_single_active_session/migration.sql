-- One active session per teacher / admin. Additive and nullable: existing rows keep all data.
ALTER TABLE "Admin" ADD COLUMN "activeSessionId" TEXT;
ALTER TABLE "Teacher" ADD COLUMN "activeSessionId" TEXT;
