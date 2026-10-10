/**
 * Native screen-share sidecar (native/share-sidecar): the capture helper's
 * frames are published to LiveKit by a separate native participant
 * (`teacher_…__screen`), so they never cross into Electron. Pure helpers
 * shared by main (spawn / control) and the class window (token / fallback).
 */
import type { InkLayer } from './inkLayer';

export const SIDECAR_SUFFIX = '__screen';
/** How long main waits for "published" before falling back to the Electron publish path. */
export const SIDECAR_PUBLISH_TIMEOUT_MS = 15_000;

export type SidecarCrop = { x: number; y: number; w: number; h: number };

export type SidecarInit = {
  url: string;
  token: string;
  fps: number;
  videoFps: number;
  maxBitrate: number;
  videoBitrate: number;
  codec: 'vp9' | 'vp8';
  encoder: 'hardware' | 'software';
  crop: SidecarCrop | null;
  audio: boolean;
};

export type SidecarRequest = { url: string; token: string; crop?: SidecarCrop | null; audio?: boolean; fps?: number; videoFps?: number };

export function isSidecarIdentity(identity: string): boolean {
  return identity.startsWith('teacher_') && identity.endsWith(SIDECAR_SUFFIX);
}

/** Region share: the region as fractions of the shared display (the sidecar crops after compositing ink). */
export function cropFractions(
  region: { x: number; y: number; w: number; h: number } | null | undefined,
  display: { x: number; y: number; w: number; h: number } | null | undefined
): SidecarCrop | null {
  if (!region || !display || !(display.w > 0) || !(display.h > 0)) return null;
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return {
    x: c((region.x - display.x) / display.w),
    y: c((region.y - display.y) / display.h),
    w: c(region.w / display.w),
    h: c(region.h / display.h),
  };
}

export function sidecarInit(req: SidecarRequest, media: { slidesFps: number; videoFps: number; maxBitrate: number; videoBitrate: number }): SidecarInit | null {
  if (typeof req.url !== 'string' || !/^wss?:\/\//.test(req.url)) return null;
  if (typeof req.token !== 'string' || req.token.length < 20 || req.token.length > 4096) return null;
  const fps = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(30, Math.round(v))) : d);
  return {
    url: req.url,
    token: req.token,
    fps: fps(req.fps, media.slidesFps),
    videoFps: fps(req.videoFps, media.videoFps),
    maxBitrate: media.maxBitrate,
    videoBitrate: media.videoBitrate,
    codec: 'vp9',
    encoder: 'hardware',
    crop: req.crop ?? null,
    audio: !!req.audio,
  };
}

/** One control line. */
export function controlLine(msg: { op: 'mode'; videoMode: boolean } | { op: 'fps'; fps: number } | { op: 'audio'; on: boolean } | { op: 'ink-clear' } | { op: 'stop' }): string {
  return `${JSON.stringify(msg)}\n`;
}

/** Ink layer → header line + raw RGBA bytes (cropped layer, as main already keeps it). */
export function inkMessage(layer: InkLayer | null): Buffer {
  if (!layer || !(layer.w > 0) || !(layer.h > 0)) return Buffer.from(controlLine({ op: 'ink-clear' }));
  const head = JSON.stringify({ op: 'ink', fw: layer.fw, fh: layer.fh, x: layer.x, y: layer.y, w: layer.w, h: layer.h, bytes: layer.rgba.byteLength });
  return Buffer.concat([Buffer.from(`${head}\n`), Buffer.from(layer.rgba.buffer, layer.rgba.byteOffset, layer.rgba.byteLength)]);
}

/** Main → class window: which path publishes the share. */
export type Publisher = 'sidecar' | 'electron';
