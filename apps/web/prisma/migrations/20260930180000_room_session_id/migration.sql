-- Per-session nonce for the LiveKit room name (classroom_<CODE>_<sessionId>).
-- Rotated every time a permanent room is (re)opened, so LiveKit tokens minted
-- for an earlier session cannot join the next one.
ALTER TABLE "Room" ADD COLUMN "sessionId" TEXT NOT NULL DEFAULT substr(md5(random()::text || clock_timestamp()::text), 1, 16);
-- Prisma generates new values client-side (@default(cuid())); drop the DB default.
ALTER TABLE "Room" ALTER COLUMN "sessionId" DROP DEFAULT;
