-- AlterTable
ALTER TABLE "Teacher" ADD COLUMN "permanentCode" TEXT;

-- Backfill from each teacher's preferred room (live/waiting first, then newest)
UPDATE "Teacher" t
SET "permanentCode" = r.code
FROM (
  SELECT DISTINCT ON ("teacherId") "teacherId", code
  FROM "Room"
  ORDER BY
    "teacherId",
    CASE WHEN status = 'ENDED' THEN 1 ELSE 0 END,
    "createdAt" DESC
) r
WHERE t.id = r."teacherId"
  AND t."permanentCode" IS NULL;

-- Teachers with no rooms yet: derive a 6-char code from id hash (A-Z2-9 alphabet-ish)
UPDATE "Teacher"
SET "permanentCode" = UPPER(SUBSTRING(REGEXP_REPLACE(md5(id || email), '[01]', 'X', 'g'), 1, 6))
WHERE "permanentCode" IS NULL;

-- Resolve rare collisions by appending index from row number
-- NOTE: ROW_NUMBER() returns bigint and PostgreSQL has no
-- substring(text, bigint, int); the ::int cast is required or this fails to parse.
WITH dups AS (
  SELECT id, "permanentCode",
    ROW_NUMBER() OVER (PARTITION BY "permanentCode" ORDER BY "createdAt") AS rn
  FROM "Teacher"
)
UPDATE "Teacher" t
SET "permanentCode" = LEFT(d."permanentCode", 5) || SUBSTRING('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', d.rn::int, 1)
FROM dups d
WHERE t.id = d.id AND d.rn > 1;

ALTER TABLE "Teacher" ALTER COLUMN "permanentCode" SET NOT NULL;

CREATE UNIQUE INDEX "Teacher_permanentCode_key" ON "Teacher"("permanentCode");
