-- Teacher can switch the waiting room off for the running class session.
ALTER TABLE "Room" ADD COLUMN "waitingRoomOn" BOOLEAN NOT NULL DEFAULT true;
