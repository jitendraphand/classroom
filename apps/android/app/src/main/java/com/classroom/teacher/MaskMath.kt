package com.classroom.teacher

/** Plain rectangle (left/top inclusive, right/bottom exclusive) so the math is JVM unit-testable. */
data class IntRect(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
    val isEmpty: Boolean get() = width <= 0 || height <= 0
}

/**
 * Maps the floating toolbar's on-screen rectangle (display pixels, current
 * orientation, from View.getLocationOnScreen) into the screen-capture frame
 * buffer, so the processor can paint it black before the frame is encoded.
 */
object MaskMath {
    /**
     * @param screen toolbar rect in display pixels
     * @param displayW display width in pixels, current orientation (the full display MediaProjection mirrors)
     * @param bufferW frame buffer width as delivered (before applying [rotation])
     * @param rotation VideoFrame rotation: degrees clockwise the buffer must be turned to be upright (0/90/180/270)
     * @param margin extra display pixels around the rect (shadows, frames that lag a drag)
     * @return rect in buffer pixels, even-aligned (I420 chroma is half resolution) and clamped; null if nothing to mask
     */
    /** Capture size for a display: same aspect ratio, long side at most [maxLong], even dimensions. */
    fun captureSize(displayW: Int, displayH: Int, maxLong: Int = 1920): Pair<Int, Int> {
        if (displayW <= 0 || displayH <= 0) return 1920 to 1080
        val long = maxOf(displayW, displayH)
        val scale = if (long > maxLong) maxLong.toDouble() / long else 1.0
        val w = (Math.round(displayW * scale / 2.0) * 2).toInt().coerceAtLeast(2)
        val h = (Math.round(displayH * scale / 2.0) * 2).toInt().coerceAtLeast(2)
        return w to h
    }

    fun bufferRect(
        screen: IntRect,
        displayW: Int,
        displayH: Int,
        bufferW: Int,
        bufferH: Int,
        rotation: Int,
        margin: Int,
    ): IntRect? {
        if (displayW <= 0 || displayH <= 0 || bufferW <= 0 || bufferH <= 0 || screen.isEmpty) return null
        // 1. Grow by the margin and clamp to the display.
        val l = (screen.left - margin).coerceIn(0, displayW)
        val t = (screen.top - margin).coerceIn(0, displayH)
        val r = (screen.right + margin).coerceIn(0, displayW)
        val b = (screen.bottom + margin).coerceIn(0, displayH)
        if (r <= l || b <= t) return null
        // 2. Scale into the upright frame. The capture may be downscaled, and
        //    when its aspect ratio differs from the display the virtual
        //    display is letterboxed (fit + centred), so use one scale factor
        //    and the centring offset.
        val rot = ((rotation % 360) + 360) % 360
        val uprightW = if (rot == 90 || rot == 270) bufferH else bufferW
        val uprightH = if (rot == 90 || rot == 270) bufferW else bufferH
        val s = minOf(uprightW.toDouble() / displayW, uprightH.toDouble() / displayH)
        val ox = (uprightW - displayW * s) / 2.0
        val oy = (uprightH - displayH * s) / 2.0
        val ul = Math.floor(ox + l * s + EPS).toInt().coerceIn(0, uprightW)
        val ut = Math.floor(oy + t * s + EPS).toInt().coerceIn(0, uprightH)
        val ur = Math.ceil(ox + r * s - EPS).toInt().coerceIn(0, uprightW)
        val ub = Math.ceil(oy + b * s - EPS).toInt().coerceIn(0, uprightH)
        // 3. Undo the frame rotation (upright → buffer coordinates).
        val raw = when (rot) {
            90 -> IntRect(ut, uprightW - ur, ub, uprightW - ul)
            180 -> IntRect(bufferW - ur, bufferH - ub, bufferW - ul, bufferH - ut)
            270 -> IntRect(bufferW - ub, ul, bufferW - ut, ur)
            else -> IntRect(ul, ut, ur, ub)
        }
        // 4. Even-align outwards and clamp to the buffer.
        val out = IntRect(
            floorEven(raw.left).coerceIn(0, bufferW),
            floorEven(raw.top).coerceIn(0, bufferH),
            ceilEven(raw.right).coerceIn(0, bufferW),
            ceilEven(raw.bottom).coerceIn(0, bufferH),
        )
        return if (out.isEmpty) null else out
    }

    /** Bounding box of two rects. */
    fun union(a: IntRect, b: IntRect) =
        IntRect(minOf(a.left, b.left), minOf(a.top, b.top), maxOf(a.right, b.right), maxOf(a.bottom, b.bottom))

    private const val EPS = 1e-6

    private fun floorEven(v: Int) = if (v % 2 == 0) v else v - 1
    private fun ceilEven(v: Int) = if (v % 2 == 0) v else v + 1
}
