import type { SlotCount } from './classLogic';

export type VideoCell = {
  key: string;
  label: string;
  pinned: boolean;
  canPin: boolean;
  participantId: string | null;
};

export type VideoModel = {
  slots: SlotCount;
  cells: VideoCell[];
};
