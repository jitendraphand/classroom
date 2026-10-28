-- Additive: an optional link from a SUB admin role to an existing teacher.
-- Existing rows keep NULL; nothing is dropped or rewritten.
ALTER TABLE "Admin" ADD COLUMN IF NOT EXISTS "teacherId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Admin_teacherId_key" ON "Admin"("teacherId");
DO $$ BEGIN
  ALTER TABLE "Admin" ADD CONSTRAINT "Admin_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
