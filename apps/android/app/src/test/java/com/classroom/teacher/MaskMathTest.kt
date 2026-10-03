package com.classroom.teacher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MaskMathTest {
    private fun covers(outer: IntRect, inner: IntRect) =
        outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom

    @Test
    fun sameSizeNoRotation_growsByMarginAndEvenAligns() {
        val r = MaskMath.bufferRect(IntRect(101, 201, 301, 251), 1080, 2400, 1080, 2400, 0, 10)!!
        assertEquals(IntRect(90, 190, 312, 262), r)
    }

    @Test
    fun downscaledCapture_scalesProportionally() {
        // 1080x2400 display captured at 864x1920 (scale 0.8).
        val r = MaskMath.bufferRect(IntRect(100, 1000, 400, 1200), 1080, 2400, 864, 1920, 0, 0)!!
        assertEquals(IntRect(80, 800, 320, 960), r)
    }

    @Test
    fun letterboxedCapture_addsCentringOffset() {
        // 1080x2400 (20:9) display into a 1080x1920 buffer: fit scale 0.8, pillarbox 108px each side.
        val r = MaskMath.bufferRect(IntRect(0, 0, 100, 100), 1080, 2400, 1080, 1920, 0, 0)!!
        assertEquals(IntRect(108, 0, 188, 80), r)
    }

    @Test
    fun marginIsClampedToDisplay() {
        val r = MaskMath.bufferRect(IntRect(0, 0, 50, 50), 1000, 2000, 1000, 2000, 0, 30)!!
        assertEquals(IntRect(0, 0, 80, 80), r)
    }

    @Test
    fun rotation90_mapsUprightToBuffer() {
        // Upright frame 1000x2000; buffer is 2000x1000 rotated 90° clockwise to display.
        val screen = IntRect(100, 200, 300, 400)
        val r = MaskMath.bufferRect(screen, 1000, 2000, 2000, 1000, 90, 0)!!
        // Buffer x = upright y; buffer y = uprightW - upright x.
        assertEquals(IntRect(200, 700, 400, 900), r)
    }

    @Test
    fun rotation180_and270() {
        val screen = IntRect(100, 200, 300, 400)
        assertEquals(IntRect(700, 1600, 900, 1800), MaskMath.bufferRect(screen, 1000, 2000, 1000, 2000, 180, 0))
        assertEquals(IntRect(1600, 100, 1800, 300), MaskMath.bufferRect(screen, 1000, 2000, 2000, 1000, 270, 0))
    }

    @Test
    fun oddScaling_alwaysCoversTheToolbar() {
        val screen = IntRect(333, 777, 555, 999)
        val r = MaskMath.bufferRect(screen, 1080, 2340, 886, 1920, 0, 0)!!
        val s = 886.0 / 1080
        val exact = IntRect((333 * s).toInt(), (777 * s).toInt(), Math.ceil(555 * s).toInt(), Math.ceil(999 * s).toInt())
        assertTrue(covers(r, exact))
        assertEquals(0, r.left % 2); assertEquals(0, r.top % 2); assertEquals(0, r.right % 2); assertEquals(0, r.bottom % 2)
    }

    @Test
    fun offscreenOrEmpty_returnsNull() {
        assertNull(MaskMath.bufferRect(IntRect(10, 10, 10, 50), 1000, 2000, 1000, 2000, 0, 0))
        assertNull(MaskMath.bufferRect(IntRect(2000, 3000, 2100, 3100), 1000, 2000, 1000, 2000, 0, 0))
        assertNull(MaskMath.bufferRect(IntRect(0, 0, 10, 10), 0, 0, 1000, 2000, 0, 0))
    }

    @Test
    fun captureSize_keepsAspectWithinLimit() {
        assertEquals(864 to 1920, MaskMath.captureSize(1080, 2400))
        assertEquals(1920 to 864, MaskMath.captureSize(2400, 1080))
        assertEquals(720 to 1280, MaskMath.captureSize(720, 1280))
    }

    @Test
    fun union_isBoundingBox() {
        assertEquals(IntRect(0, 5, 30, 40), MaskMath.union(IntRect(0, 10, 20, 40), IntRect(10, 5, 30, 20)))
    }
}
