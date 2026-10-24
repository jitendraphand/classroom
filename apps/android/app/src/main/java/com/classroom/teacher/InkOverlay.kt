package com.classroom.teacher

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager

/**
 * Students' ink drawn over whatever the teacher shares (desktop ink): a
 * full-screen overlay window that never takes touches. Because it is on
 * screen it is part of the capture, so students see it in the video and the
 * stage is published with desktopInk = true (clients then fade their local
 * copy, like the Windows app).
 *
 * Android 12+ only lets touches pass through an overlay of another app when
 * its opacity is ≤ 0.8, so the window alpha is 0.8. Needs "Display over other
 * apps"; without it ink is simply not shown on the teacher's screen (students
 * still see each other's ink drawn locally, desktopInk = false).
 */
class InkOverlay(private val context: Context) {
    private val wm = context.getSystemService(WindowManager::class.java)
    private var view: InkView? = null
    private var strokes: List<Realtime.InkStroke> = emptyList()

    val available get() = Settings.canDrawOverlays(context)
    val shown get() = view != null

    fun show() {
        if (view != null || !available) return
        val v = InkView(context)
        val p = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            alpha = 0.8f
            if (Build.VERSION.SDK_INT >= 28) layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        try {
            wm.addView(v, p)
            view = v
            v.strokes = strokes
        } catch (_: Exception) {
        }
    }

    fun hide() {
        val v = view ?: return
        view = null
        try { wm.removeView(v) } catch (_: Exception) {}
    }

    fun update(s: List<Realtime.InkStroke>) {
        strokes = s.toList()
        view?.let { it.strokes = strokes; it.invalidate() }
    }

    /** Draws normalised (0..1) points over the full display; repaints only on change. */
    @SuppressLint("ViewConstructor")
    private class InkView(context: Context) : View(context) {
        var strokes: List<Realtime.InkStroke> = emptyList()
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val path = Path()

        override fun onDraw(canvas: Canvas) {
            val w = width.toFloat()
            val h = height.toFloat()
            paint.strokeWidth = 4f * resources.displayMetrics.density
            for (s in strokes) {
                if (s.pts.size < 2) continue
                paint.color = Realtime.DRAW_COLORS[s.color] ?: 0xFFEF4444.toInt()
                path.reset()
                path.moveTo(s.pts[0] * w, s.pts[1] * h)
                var i = 2
                while (i + 1 < s.pts.size) { path.lineTo(s.pts[i] * w, s.pts[i + 1] * h); i += 2 }
                if (s.pts.size == 2) path.lineTo(s.pts[0] * w + 0.1f, s.pts[1] * h)
                canvas.drawPath(path, paint)
            }
        }
    }
}
