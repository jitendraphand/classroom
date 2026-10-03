-- Teacher-pinned student video (per class-session participant).
ALTER TABLE "Participant" ADD COLUMN "pinnedAt" TIMESTAMP(3);
