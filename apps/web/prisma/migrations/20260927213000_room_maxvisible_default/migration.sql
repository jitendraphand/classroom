-- Align the stored default with schema.prisma (@default(6)).
--
-- The initial migration shipped DEFAULT 10 while the Prisma schema declares 6,
-- so a database built from migrations did not match a database built from
-- `prisma db push`. Application behaviour is unaffected because room creation
-- always passes an explicit clamped value (clampMaxVisible), but the drift made
-- `prisma migrate diff --from-migrations --to-schema-datamodel` report a diff on
-- every CI run.
ALTER TABLE "Room" ALTER COLUMN "maxVisibleVideos" SET DEFAULT 6;
