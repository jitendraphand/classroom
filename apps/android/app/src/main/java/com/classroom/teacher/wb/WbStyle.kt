package com.classroom.teacher.wb

/**
 * Drawing rules shared with the web / Windows whiteboard (render.ts,
 * WhiteboardBoard.tsx), so a page looks the same on every device. Pure JVM:
 * WebParityTest checks them against the web sources.
 */
object WbStyle {
    /** Pen widths offered in the colour & size group (web WIDTHS). */
    val WIDTHS = listOf(2, 4, 8, 14, 24)

    /** Width of a pressure stroke at pressure [pr] (0–100): web widthAt. */
    fun widthAt(w: Float, pr: Int): Float = w * (0.35f + 0.9f * pr / 100f)

    /** Highlighter strokes are three times the chosen width (web editor). */
    fun highlighterWidth(width: Int) = width * 3

    /** Text size for the chosen width (web editor). */
    fun textSize(width: Int) = 24 + width * 4

    /** Page fill per background (web bgColor). */
    fun bgColor(bg: String): Long = if (bg == "black") 0xFF111418 else 0xFFFFFFFF

    /** Labels used for backgrounds on every app (web BG_LABEL). */
    val BG_LABEL = mapOf("white" to "Plain", "grid" to "Grid", "lined" to "Lined", "dots" to "Dots", "graph" to "Graph", "black" to "Black")
}

/**
 * Viewer-local zoom / pan (port of the web lib/zoomPan.ts): screen = content
 * * s + (x, y) over the fitted page, top-left origin of a w×h box.
 */
data class ZoomPan(val s: Float = 1f, val x: Float = 0f, val y: Float = 0f) {
    val zoomed get() = kotlin.math.abs(s - 1f) > 0.01f || kotlin.math.abs(x) > 0.5f || kotlin.math.abs(y) > 0.5f

    companion object {
        const val MAX = 5f

        /** Keep the content covering the box when zoomed in; centred when zoomed out (web clampZP). */
        fun clamp(t: ZoomPan, w: Float, h: Float, min: Float = 1f, max: Float = MAX): ZoomPan {
            val s = kotlin.math.min(max, kotlin.math.max(min, if (t.s.isFinite()) t.s else 1f))
            fun axis(v: Float, size: Float): Float {
                val span = size * s
                if (span <= size) return (size - span) / 2
                return kotlin.math.min(0f, kotlin.math.max(size - span, if (v.isFinite()) v else 0f))
            }
            return ZoomPan(s, axis(t.x, w), axis(t.y, h))
        }

        /** Zoom by [factor] keeping (sx, sy) fixed (web zoomAt). */
        fun zoomAt(t: ZoomPan, factor: Float, sx: Float, sy: Float, w: Float, h: Float, min: Float = 1f, max: Float = MAX): ZoomPan {
            val s2 = kotlin.math.min(max, kotlin.math.max(min, t.s * factor))
            val k = s2 / t.s
            return clamp(ZoomPan(s2, sx - (sx - t.x) * k, sy - (sy - t.y) * k), w, h, min, max)
        }

        fun panBy(t: ZoomPan, dx: Float, dy: Float, w: Float, h: Float, min: Float = 1f, max: Float = MAX): ZoomPan =
            clamp(ZoomPan(t.s, t.x + dx, t.y + dy), w, h, min, max)

        /** Two-finger pinch (web pinchZP): scale about the old midpoint, then follow it. */
        fun pinch(t: ZoomPan, a0x: Float, a0y: Float, b0x: Float, b0y: Float, a1x: Float, a1y: Float, b1x: Float, b1y: Float, w: Float, h: Float, min: Float = 1f, max: Float = MAX): ZoomPan {
            val d0 = kotlin.math.hypot(a0x - b0x, a0y - b0y)
            val d1 = kotlin.math.hypot(a1x - b1x, a1y - b1y)
            val m0x = (a0x + b0x) / 2; val m0y = (a0y + b0y) / 2
            val m1x = (a1x + b1x) / 2; val m1y = (a1y + b1y) / 2
            val zoomed = if (d0 > 4 && d1 > 0) zoomAt(t, d1 / d0, m0x, m0y, w, h, min, max) else t
            return panBy(zoomed, m1x - m0x, m1y - m0y, w, h, min, max)
        }
    }
}
