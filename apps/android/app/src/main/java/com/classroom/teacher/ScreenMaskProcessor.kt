package com.classroom.teacher

import livekit.org.webrtc.JavaI420Buffer
import livekit.org.webrtc.VideoFrame
import livekit.org.webrtc.VideoProcessor
import livekit.org.webrtc.VideoSink
import java.nio.ByteBuffer

/**
 * Sits between the MediaProjection capturer and the encoder of the published
 * screen share. While the floating toolbar is on screen, every frame is
 * converted to I420 and the toolbar's rectangle (plus a margin) is painted
 * black, so students never see the teacher's controls, chat or waiting list.
 * With no toolbar visible (or masking turned off) frames pass through
 * untouched, at no cost.
 */
class ScreenMaskProcessor : VideoProcessor {
    /**
     * Toolbar rect in display pixels (current orientation); null = nothing to
     * hide. The captured frame can lag the window move by a frame or two, so
     * for [TRAIL_MS] after a change the union with the previous rect is masked
     * (a fast drag never shows the toolbar at its old spot).
     */
    var maskRect: IntRect?
        get() = current
        set(value) {
            synchronized(this) {
                if (value == current) return
                val prev = current
                trail = if (prev != null && value != null && prev != value) prev else null
                trailUntilNs = System.nanoTime() + TRAIL_MS * 1_000_000
                current = value
            }
        }

    @Volatile
    private var current: IntRect? = null

    @Volatile
    private var trail: IntRect? = null

    @Volatile
    private var trailUntilNs = 0L

    private fun effectiveRect(): IntRect? = synchronized(this) {
        val c = current ?: return null
        val t = trail
        if (t == null || System.nanoTime() > trailUntilNs) c else MaskMath.union(c, t)
    }

    /** Full display size in pixels, current orientation. */
    @Volatile
    var displaySize: Pair<Int, Int> = 0 to 0

    /** Teacher switch (e.g. off for an Android 14 single-app share, where the toolbar is not captured). */
    @Volatile
    var enabled: Boolean = true

    @Volatile
    var marginPx: Int = 24

    @Volatile
    private var sink: VideoSink? = null

    override fun setSink(sink: VideoSink?) {
        this.sink = sink
    }

    override fun onCapturerStarted(success: Boolean) = Unit

    override fun onCapturerStopped() = Unit

    /**
     * The capturer observer hands us the full-size frame plus the adaptation
     * (crop / scale) WebRTC wants. Mask on the full frame first, where the
     * display → buffer mapping is exact, then apply the adaptation.
     */
    override fun onFrameCaptured(frame: VideoFrame, parameters: VideoProcessor.FrameAdaptationParameters) {
        if (parameters.drop) return
        val masked = maskedOrNull(frame) ?: run {
            if (needsMask(frame)) return // conversion failed: never leak the unmasked frame
            frame.retain()
            frame
        }
        try {
            val adapted = VideoProcessor.applyFrameAdaptationParameters(masked, parameters) ?: return
            try {
                sink?.onFrame(adapted)
            } finally {
                adapted.release()
            }
        } finally {
            masked.release()
        }
    }

    override fun onFrameCaptured(frame: VideoFrame) {
        val out = sink ?: return
        val masked = maskedOrNull(frame)
        if (masked == null) {
            if (!needsMask(frame)) out.onFrame(frame)
            return
        }
        try {
            out.onFrame(masked)
        } finally {
            masked.release()
        }
    }

    private fun target(frame: VideoFrame): IntRect? {
        if (!enabled) return null
        val rect = effectiveRect() ?: return null
        val (dw, dh) = displaySize
        val buffer = frame.buffer
        return MaskMath.bufferRect(rect, dw, dh, buffer.width, buffer.height, frame.rotation, marginPx)
    }

    private fun needsMask(frame: VideoFrame) = target(frame) != null

    /** A new (caller-released) frame with the toolbar painted black, or null when nothing needs masking or conversion failed. */
    private fun maskedOrNull(frame: VideoFrame): VideoFrame? {
        val target = target(frame) ?: return null
        val i420 = try {
            writableI420(frame.buffer)
        } catch (e: Exception) {
            null
        } ?: return null
        paintBlack(i420, target)
        return VideoFrame(i420, frame.rotation, frame.timestampNs)
    }

    /** Texture frames (the MediaProjection case) convert into a fresh buffer; an I420 input is copied so the capturer's memory is never written. */
    private fun writableI420(buffer: VideoFrame.Buffer): VideoFrame.I420Buffer? {
        val converted = buffer.toI420() ?: return null
        if (buffer !is VideoFrame.I420Buffer) return converted
        val copy = JavaI420Buffer.allocate(converted.width, converted.height)
        copyPlane(converted.dataY, converted.strideY, copy.dataY, copy.strideY, converted.width, converted.height)
        val cw = (converted.width + 1) / 2
        val ch = (converted.height + 1) / 2
        copyPlane(converted.dataU, converted.strideU, copy.dataU, copy.strideU, cw, ch)
        copyPlane(converted.dataV, converted.strideV, copy.dataV, copy.strideV, cw, ch)
        converted.release()
        return copy
    }

    private fun copyPlane(src: ByteBuffer, srcStride: Int, dst: ByteBuffer, dstStride: Int, w: Int, h: Int) {
        val row = ByteArray(w)
        for (y in 0 until h) {
            src.position(y * srcStride)
            src.get(row, 0, w)
            dst.position(y * dstStride)
            dst.put(row, 0, w)
        }
    }

    private fun paintBlack(b: VideoFrame.I420Buffer, r: IntRect) {
        fill(b.dataY, b.strideY, r.left, r.top, r.right, r.bottom, 16)
        val cl = r.left / 2
        val ct = r.top / 2
        val cr = minOf((r.right + 1) / 2, (b.width + 1) / 2)
        val cb = minOf((r.bottom + 1) / 2, (b.height + 1) / 2)
        fill(b.dataU, b.strideU, cl, ct, cr, cb, 128)
        fill(b.dataV, b.strideV, cl, ct, cr, cb, 128)
    }

    private fun fill(plane: ByteBuffer, stride: Int, l: Int, t: Int, r: Int, bottom: Int, value: Int) {
        val w = r - l
        if (w <= 0) return
        val row = ByteArray(w) { value.toByte() }
        for (y in t until bottom) {
            plane.position(y * stride + l)
            plane.put(row, 0, w)
        }
    }

    companion object {
        private const val TRAIL_MS = 300L
    }
}
