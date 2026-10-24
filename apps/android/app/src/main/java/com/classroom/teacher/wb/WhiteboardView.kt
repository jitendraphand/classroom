package com.classroom.teacher.wb

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.os.SystemClock
import android.util.Base64
import android.util.LruCache
import android.view.MotionEvent
import android.view.View
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * The board canvas (web WhiteboardBoard, edit mode). Draws the current page of
 * [host] letterboxed at 16:9 and turns touches into ops. Redraws only when
 * something changed (no animation loop); pen points are batched every 30 ms
 * into one `pts` op like the web PointBatcher.
 */
@SuppressLint("ViewConstructor")
class WhiteboardView(context: Context, private val host: () -> WbHost?, private val onText: (x: Int, y: Int) -> Unit) : View(context) {
    enum class Tool { PEN, HIGHLIGHT, ERASER, LINE, ARROW, RECT, ELLIPSE, TEXT }

    var tool = Tool.PEN
    var color = "#111111"
    var penWidth = 4
    var me = "teacher"
    var onLocalChange: (() -> Unit)? = null

    private val density = resources.displayMetrics.density
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG)
    private val pathCache = HashMap<String, Pair<Int, Path>>()
    private val images = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private val page = RectF()
    private var scale = 1f

    // Gesture state.
    private var batcher: PointBatcher? = null
    private var lastFlush = 0L
    private var shapeStart: Pair<Float, Float>? = null
    private var shapeEnd: Pair<Float, Float>? = null
    private val erasing = HashSet<String>()
    private val flush = Runnable { flushPoints() }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        val pad = 8 * density
        val aw = w - 2 * pad
        val ah = h - 2 * pad
        scale = min(aw / Wb.PAGE_W, ah / Wb.PAGE_H)
        val pw = Wb.PAGE_W * scale
        val ph = Wb.PAGE_H * scale
        page.set((w - pw) / 2, (h - ph) / 2, (w + pw) / 2, (h + ph) / 2)
    }

    private fun toPage(x: Float, y: Float) = ((x - page.left) / scale).toDouble() to ((y - page.top) / scale).toDouble()

    override fun onDraw(canvas: Canvas) {
        val h = host() ?: return
        val p = h.doc.currentPage()
        canvas.drawColor(0xFF0B0F14.toInt())
        fill.color = if (p.bg == "black") Color.BLACK else Color.WHITE
        canvas.drawRect(page, fill)
        canvas.save()
        canvas.clipRect(page)
        canvas.translate(page.left, page.top)
        canvas.scale(scale, scale)
        drawBackground(canvas, p.bg)
        for (it in p.items) if (it.id !in erasing) drawItem(canvas, it)
        // Shape preview.
        val s = shapeStart
        val e = shapeEnd
        if (s != null && e != null) {
            stroke.color = parse(color); stroke.alpha = 255; stroke.strokeWidth = penWidth.toFloat()
            drawShape(canvas, toolKind(), s.first, s.second, e.first, e.second)
        }
        canvas.restore()
    }

    private fun drawBackground(c: Canvas, bg: String) {
        if (bg != "grid" && bg != "lined") return
        fill.color = 0xFFDBE3EC.toInt()
        fill.strokeWidth = 1.5f
        val step = 60f
        var y = step
        while (y < Wb.PAGE_H) { c.drawLine(0f, y, Wb.PAGE_W.toFloat(), y, fill); y += step }
        if (bg == "grid") {
            var x = step
            while (x < Wb.PAGE_W) { c.drawLine(x, 0f, x, Wb.PAGE_H.toFloat(), fill); x += step }
        }
    }

    private fun parse(c: String) = try { Color.parseColor(c) } catch (_: Exception) { Color.BLACK }

    private fun drawItem(c: Canvas, it: Item) {
        when (it) {
            is Item.Stroke -> {
                stroke.color = parse(it.c)
                stroke.alpha = if (it.tool == "hl") 90 else 255
                stroke.strokeWidth = it.w.toFloat()
                val n = it.pts.size
                if (n == 2) {
                    fill.color = stroke.color; fill.alpha = stroke.alpha
                    c.drawCircle(it.pts[0].toFloat(), it.pts[1].toFloat(), it.w / 2f, fill)
                    fill.alpha = 255
                    return
                }
                val cached = pathCache[it.id]
                val path: Path
                if (cached != null && cached.first <= n) {
                    path = cached.second
                    var i = cached.first
                    while (i + 1 < n) { path.lineTo(it.pts[i].toFloat(), it.pts[i + 1].toFloat()); i += 2 }
                } else {
                    path = Path()
                    path.moveTo(it.pts[0].toFloat(), it.pts[1].toFloat())
                    var i = 2
                    while (i + 1 < n) { path.lineTo(it.pts[i].toFloat(), it.pts[i + 1].toFloat()); i += 2 }
                }
                pathCache[it.id] = n to path
                c.drawPath(path, stroke)
            }
            is Item.Shape -> {
                stroke.color = parse(it.c); stroke.alpha = 255; stroke.strokeWidth = it.w.toFloat()
                drawShape(c, it.k, it.x1.toFloat(), it.y1.toFloat(), it.x2.toFloat(), it.y2.toFloat())
            }
            is Item.Text -> {
                text.color = parse(it.c)
                text.textSize = it.size.toFloat()
                var y = it.y + it.size.toFloat()
                for (line in it.text.split('\n')) { c.drawText(line, it.x.toFloat(), y, text); y += it.size * 1.25f }
            }
            is Item.Image -> {
                val bmp = image(it) ?: return
                c.drawBitmap(bmp, null, RectF(it.x.toFloat(), it.y.toFloat(), (it.x + it.w).toFloat(), (it.y + it.h).toFloat()), null)
            }
        }
    }

    private fun image(it: Item.Image): Bitmap? {
        images.get(it.id)?.let { b -> return b }
        return try {
            val raw = Base64.decode(it.src.substringAfter(","), Base64.DEFAULT)
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(raw, 0, raw.size, o)
            var sample = 1
            while (o.outWidth / (sample * 2) >= 1600 || o.outHeight / (sample * 2) >= 1600) sample *= 2
            BitmapFactory.decodeByteArray(raw, 0, raw.size, BitmapFactory.Options().apply { inSampleSize = sample })?.also { b -> images.put(it.id, b) }
        } catch (_: Exception) {
            null
        }
    }

    private fun drawShape(c: Canvas, k: String, x1: Float, y1: Float, x2: Float, y2: Float) {
        when (k) {
            "line" -> c.drawLine(x1, y1, x2, y2, stroke)
            "arrow" -> {
                c.drawLine(x1, y1, x2, y2, stroke)
                val a = atan2((y2 - y1).toDouble(), (x2 - x1).toDouble())
                val len = max(14f, stroke.strokeWidth * 4)
                for (d in listOf(Math.PI * 0.85, -Math.PI * 0.85)) {
                    c.drawLine(x2, y2, (x2 + len * cos(a + d)).toFloat(), (y2 + len * sin(a + d)).toFloat(), stroke)
                }
            }
            "rect" -> c.drawRect(min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2), stroke)
            "ellipse" -> c.drawOval(min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2), stroke)
        }
    }

    private fun toolKind() = when (tool) {
        Tool.LINE -> "line"; Tool.ARROW -> "arrow"; Tool.RECT -> "rect"; Tool.ELLIPSE -> "ellipse"; else -> ""
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        val h = host() ?: return false
        val pg = h.doc.currentPage()
        val (x, y) = toPage(e.x, e.y)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                when (tool) {
                    Tool.PEN, Tool.HIGHLIGHT -> {
                        val id = Wb.newId("s")
                        val w = if (tool == Tool.HIGHLIGHT) max(16, penWidth * 4) else penWidth
                        val item = Item.Stroke(id, me, if (tool == Tool.HIGHLIGHT) "hl" else "pen", color, w, IntArrayList().also {
                            it.add(Math.floor(x + 0.5).toInt()); it.add(Math.floor(y + 0.5).toInt())
                        })
                        h.local(listOf(WbOps.add(pg.id, item)))
                        batcher = PointBatcher(pg.id, id)
                        lastFlush = SystemClock.uptimeMillis()
                    }
                    Tool.ERASER -> { erasing.clear(); erase(pg, x, y) }
                    Tool.TEXT -> {
                        onText(x.toInt(), y.toInt())
                        return true
                    }
                    else -> { shapeStart = x.toFloat() to y.toFloat(); shapeEnd = shapeStart }
                }
                invalidate()
            }
            MotionEvent.ACTION_MOVE -> {
                when (tool) {
                    Tool.PEN, Tool.HIGHLIGHT -> {
                        val b = batcher ?: return true
                        for (i in 0 until e.historySize) {
                            val (hx, hy) = toPage(e.getHistoricalX(i), e.getHistoricalY(i))
                            b.push(hx, hy)
                        }
                        b.push(x, y)
                        val now = SystemClock.uptimeMillis()
                        if (now - lastFlush >= Wb.BATCH_MS) flushPoints() else { removeCallbacks(flush); postDelayed(flush, Wb.BATCH_MS) }
                    }
                    Tool.ERASER -> erase(pg, x, y)
                    else -> if (shapeStart != null) { shapeEnd = x.toFloat() to y.toFloat(); invalidate() }
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                when (tool) {
                    Tool.PEN, Tool.HIGHLIGHT -> { flushPoints(); batcher = null }
                    Tool.ERASER -> {
                        if (erasing.isNotEmpty()) h.local(listOf(WbOps.del(pg.id, erasing.toList())))
                        erasing.clear()
                        onLocalChange?.invoke()
                    }
                    else -> {
                        val s = shapeStart
                        val en = shapeEnd
                        shapeStart = null; shapeEnd = null
                        if (s != null && en != null && hypot((en.first - s.first).toDouble(), (en.second - s.second).toDouble()) > 6) {
                            val item = Item.Shape(toolKind(), Wb.newId("h"), me, color, penWidth, s.first.toInt(), s.second.toInt(), en.first.toInt(), en.second.toInt())
                            h.local(listOf(WbOps.add(pg.id, item)))
                            onLocalChange?.invoke()
                        }
                    }
                }
                invalidate()
            }
        }
        return true
    }

    private fun erase(pg: Page, x: Double, y: Double) {
        val r = 14.0
        var hit = false
        for (it in pg.items) if (it.id !in erasing && WbGeom.hit(it, x, y, r)) { erasing.add(it.id); hit = true }
        if (hit) invalidate()
    }

    private fun flushPoints() {
        removeCallbacks(flush)
        val op = batcher?.flush() ?: return
        lastFlush = SystemClock.uptimeMillis()
        host()?.local(listOf(op), record = false)
        invalidate()
        onLocalChange?.invoke()
    }

    /** Called after remote / programmatic changes. */
    fun changed() {
        val live = host()?.doc?.pages?.flatMap { p -> p.items.map { it.id } }?.toHashSet()
        if (live != null && pathCache.size > 256) pathCache.keys.retainAll(live)
        invalidate()
    }
}
