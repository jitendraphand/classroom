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

    /**
     * Share paused (teacher back in the class screen): frames are dropped
     * before any conversion or encoding, while the MediaProjection and its
     * foreground service stay alive so resuming needs no new consent.
     */
    @Volatile
    var paused: Boolean = false

    @Volatile
    var marginPx: Int = 24

    /**
     * The toolbar window is FLAG_SECURE, so the system already paints it
     * black in the capture. Once real frames show that (the toolbar's middle
     * is black), frames pass straight through as GPU textures: no I420
     * conversion, no copy, no masking, which is what made sharing stutter.
     * Re-checked on one frame every [RECHECK_NS]; any frame that shows the
     * toolbar switches CPU masking back on, so it is never leaked.
     */
    @Volatile
    var secureOk: Boolean = false
        private set
    private var lastCheckNs = 0L

    /** New share session: verify again. */
    fun resetSecureCheck() {
        secureOk = false
        lastCheckNs = 0L
    }

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
        if (parameters.drop || paused) return
        if (passThrough(frame)) {
            val adapted = VideoProcessor.applyFrameAdaptationParameters(frame, parameters) ?: return
            try {
                sink?.onFrame(adapted)
            } finally {
                adapted.release()
            }
            return
        }
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
        if (paused) return
        val out = sink ?: return
        if (passThrough(frame)) {
            out.onFrame(frame)
            return
        }
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

    /** The toolbar is on screen but verified black already, and no re-check is due. */
    private fun passThrough(frame: VideoFrame): Boolean {
        if (!secureOk || target(frame) == null) return false
        return System.nanoTime() - lastCheckNs < RECHECK_NS
    }

    /** The toolbar's own rectangle (no margin) in buffer pixels, shrunk to its middle half. */
    private fun innerRect(frame: VideoFrame): IntRect? {
        if (!enabled) return null
        val rect = synchronized(this) { if (trail != null && System.nanoTime() <= trailUntilNs) null else current } ?: return null
        val (dw, dh) = displaySize
        val b = MaskMath.bufferRect(rect, dw, dh, frame.buffer.width, frame.buffer.height, frame.rotation, 0) ?: return null
        val qx = b.width / 4
        val qy = b.height / 4
        return IntRect(b.left + qx, b.top + qy, b.right - qx, b.bottom - qy).takeIf { !it.isEmpty }
    }

    /**
     * True when [r] is a flat black fill (the system's FLAG_SECURE paint):
     * every sampled luma pixel dark and all of them within a few levels of
     * each other. The toolbar's own dark panel always carries brighter icons
     * and outlines, so it never reads as flat.
     */
    private fun isBlack(b: VideoFrame.I420Buffer, r: IntRect): Boolean {
        val y = b.dataY
        val step = 3
        var lo = 255
        var hi = 0
        var row = maxOf(0, r.top)
        val bottom = minOf(b.height, r.bottom)
        val right = minOf(b.width, r.right)
        while (row < bottom) {
            var col = maxOf(0, r.left)
            while (col < right) {
                val v = y.get(row * b.strideY + col).toInt() and 0xFF
                if (v > BLACK_MAX_LUMA) return false
                if (v < lo) lo = v
                if (v > hi) hi = v
                col += step
            }
            row += step
        }
        return hi - lo <= BLACK_FLAT
    }

    /** A new (caller-released) frame with the toolbar painted black, or null when nothing needs masking or conversion failed. */
    private fun maskedOrNull(frame: VideoFrame): VideoFrame? {
        val target = target(frame) ?: return null
        val i420 = try {
            writableI420(frame.buffer)
        } catch (e: Exception) {
            null
        } ?: return null
        // Is the system already blacking the toolbar out (FLAG_SECURE)? Decided
        // only while the toolbar is still (a moving window can lag a frame).
        innerRect(frame)?.let { inner ->
            secureOk = isBlack(i420, inner)
            lastCheckNs = System.nanoTime()
        }
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
        /** Re-check the secure fill on one frame this often (one conversion, not one per frame). */
        private const val RECHECK_NS = 5_000_000_000L
        /** Limited-range black is 16, full-range 0; the toolbar's slate panel is above this either way. */
        private const val BLACK_MAX_LUMA = 20
        /** A system fill is flat: sampled luma may vary this much at most. */
        private const val BLACK_FLAT = 4
    }
}
