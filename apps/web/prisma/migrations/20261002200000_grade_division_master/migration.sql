-- Grade / Division master data (Admin → Grades & divisions).

-- CreateTable
CREATE TABLE "Grade" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Grade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Division" (
    "id" TEXT NOT NULL,
    "gradeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Division_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Grade_name_key" ON "Grade"("name");
CREATE INDEX "Grade_sortOrder_idx" ON "Grade"("sortOrder");
CREATE UNIQUE INDEX "Division_gradeId_name_key" ON "Division"("gradeId", "name");

-- AddForeignKey
ALTER TABLE "Division" ADD CONSTRAINT "Division_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "Grade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from what is already in use, so existing data stays valid and the
-- dropdowns show it. Same canonical forms as lib/grades.ts (grades upper-case,
-- divisions upper-case without spaces; "*" = all divisions is not a division).
-- The admin page's "Sync from existing data" button (lib/gradeMaster.ts) does
-- the same at any time.
WITH pairs AS (
    SELECT "grade" AS g, "division" AS d FROM "TeacherAssignment"
    UNION ALL SELECT "grade", unnest("divisions") FROM "TimetableSlot"
    UNION ALL SELECT "grade", NULL FROM "TimetableSlot"
    UNION ALL SELECT "grade", unnest("divisions") FROM "ScheduleOverride" WHERE "grade" IS NOT NULL
    UNION ALL SELECT "grade", NULL FROM "ScheduleOverride" WHERE "grade" IS NOT NULL
    UNION ALL SELECT "grade", "division" FROM "Student"
    UNION ALL SELECT "grade", unnest("divisions") FROM "ClassSession"
    UNION ALL SELECT "grade", NULL FROM "ClassSession"
),
norm AS (
    SELECT DISTINCT
        left(upper(regexp_replace(trim(g), '\s+', ' ', 'g')), 16) AS g,
        CASE WHEN d IS NULL THEN NULL
             ELSE left(regexp_replace(upper(trim(d)), '\s+', '', 'g'), 32) END AS d
    FROM pairs
),
grades AS (
    SELECT DISTINCT g FROM norm WHERE g <> ''
)
INSERT INTO "Grade" ("id", "name", "label", "sortOrder", "active", "updatedAt")
SELECT
    'gbf' || md5(g),
    g,
    g,
    10 * row_number() OVER (
        ORDER BY CASE WHEN g ~ '^[0-9]+$' THEN lpad(g, 8, '0') ELSE 'z' || g END
    ),
    true,
    CURRENT_TIMESTAMP
FROM grades;

WITH pairs AS (
    SELECT "grade" AS g, "division" AS d FROM "TeacherAssignment"
    UNION ALL SELECT "grade", unnest("divisions") FROM "TimetableSlot"
    UNION ALL SELECT "grade", unnest("divisions") FROM "ScheduleOverride" WHERE "grade" IS NOT NULL
    UNION ALL SELECT "grade", "division" FROM "Student"
    UNION ALL SELECT "grade", unnest("divisions") FROM "ClassSession"
),
norm AS (
    SELECT DISTINCT
        left(upper(regexp_replace(trim(g), '\s+', ' ', 'g')), 16) AS g,
        left(regexp_replace(upper(trim(d)), '\s+', '', 'g'), 32) AS d
    FROM pairs
)
INSERT INTO "Division" ("id", "gradeId", "name", "label", "active", "updatedAt")
SELECT
    'dbf' || md5(n.g || '|' || n.d),
    gr."id",
    n.d,
    CASE WHEN length(n.d) > 1 AND n.d ~ '^[A-Z]+$' THEN initcap(n.d) ELSE n.d END,
    true,
    CURRENT_TIMESTAMP
FROM norm n
JOIN "Grade" gr ON gr."name" = n.g
WHERE n.d <> '' AND n.d <> '*' AND n.d <> 'ALL';
