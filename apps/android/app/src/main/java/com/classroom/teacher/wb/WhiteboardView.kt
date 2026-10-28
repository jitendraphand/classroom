package com.classroom.teacher.wb

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.os.SystemClock
import android.util.Base64
import android.util.LruCache
import android.view.MotionEvent
import android.view.View
import java.io.ByteArrayOutputStream
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * The board canvas: the Android twin of the web WhiteboardBoard (edit mode).
 * Same tools, same drawing rules (midpoint-smoothed strokes, stylus pressure,
 * filled arrowheads, triangle, fills, backgrounds) and the same page
 * geometry, so a page looks identical on the web, Windows and here.
 *
 * Smoothness: everything except what is moving (strokes still growing, the
 * selection being dragged) is painted once into a cached bitmap; each frame
 * blits it and draws only the moving parts. Ink is drawn from every touch
 * sample (historical points included) on the next frame, while the network
 * gets one `pts` op per 30 ms. Two fingers zoom and pan (viewer-local).
 */
@SuppressLint("ViewConstructor")
class WhiteboardView(context: Context, private val host: () -> WbHost?, private val onText: (x: Int, y: Int) -> Unit) : View(context) {
    enum class Tool { SELECT, PEN, HIGHLIGHT, LASER, ERASER, AREA, LINE, ARROW, RECT, ELLIPSE, TRI, TEXT, HAND }

    var tool = Tool.PEN
        set(v) {
            field = v
            if (v != Tool.SELECT) setSelection(emptyList())
            invalidate()
        }
    var color = "#111111"
    var penWidth = 4
    var fillShapes = false
    var me = "teacher"
    var onLocalChange: (() -> Unit)? = null
    /** Teacher's laser points (page units), batched every 50 ms; lossy. */
    var onLaser: ((IntArray) -> Unit)? = null
    /** Selection changed: true when something is selected. */
    var onSelection: ((Boolean) -> Unit)? = null
    /** Zoom changed (the toolbar shows the percentage). */
    var onZoom: ((Float) -> Unit)? = null
    /** Where the selection is on screen (view px), null when none or while it moves: places the Duplicate / Delete bar. */
    var onSelectionFrame: ((RectF?) -> Unit)? = null

    val laser = LaserTrail()

    private val density = resources.displayMetrics.density
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG)
    private val ui = Paint(Paint.ANTI_ALIAS_FLAG)
    private val dashed = DashPathEffect(floatArrayOf(6 * density, 4 * density), 0f)
    private val images = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    // View transform: the page fitted to the view, then the viewer-local zoom / pan.
    private var baseScale = 1f
    private var baseX = 0f
    private var baseY = 0f
    private var zp = ZoomPan()
    private val scale get() = baseScale * zp.s
    private val tx get() = baseX * zp.s + zp.x
    private val ty get() = baseY * zp.s + zp.y
    val zoom get() = zp.s

    // Cached layer of everything that is not moving.
    private var layer: Bitmap? = null
    private var layerKey = ""

    // Gesture state.
    private var batcher: PointBatcher? = null
    private var drawingId: String? = null
    private var lastFlush = 0L
    private var snapped = false
    private var holdX = 0.0
    private var holdY = 0.0
    private var shapeStart: Pair<Double, Double>? = null
    private var shapeEnd: Pair<Double, Double>? = null
    private var panFrom: Triple<Float, Float, ZoomPan>? = null
    private var pinch: FloatArray? = null
    private var lastStylusAt = 0L
    private var selMode: String? = null
    private var selStart: Pair<Double, Double>? = null
    private var selXf: WbXf? = null
    private var selection: List<String> = emptyList()
    private val laserBuf = IntArrayList()
    private val flush = Runnable { flushPoints() }
    private val snap = Runnable { trySnap() }
    private val sendLaser = Runnable {
        val pts = laserBuf.toArray()
        laserBuf.clear()
        if (pts.isNotEmpty()) onLaser?.invoke(pts)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        baseScale = max(0.01f, min(w.toFloat() / Wb.PAGE_W, h.toFloat() / Wb.PAGE_H))
        baseX = (w - Wb.PAGE_W * baseScale) / 2
        baseY = (h - Wb.PAGE_H * baseScale) / 2
        zp = ZoomPan.clamp(zp, w.toFloat(), h.toFloat(), MIN_ZOOM)
        layer = null
    }

    private fun toPage(x: Float, y: Float) = ((x - tx) / scale).toDouble() to ((y - ty) / scale).toDouble()

    // ---- zoom (toolbar) ----
    fun zoomBy(factor: Float) {
        zp = ZoomPan.zoomAt(zp, factor, width / 2f, height / 2f, width.toFloat(), height.toFloat(), MIN_ZOOM)
        onZoom?.invoke(zp.s)
        invalidate()
    }

    fun resetZoom() {
        zp = ZoomPan.clamp(ZoomPan(), width.toFloat(), height.toFloat(), MIN_ZOOM)
        onZoom?.invoke(zp.s)
        invalidate()
    }

    // ---- drawing ----
    private fun parse(c: String) = try { Color.parseColor(c) } catch (_: Exception) { Color.BLACK }

    private fun drawBackground(c: Canvas, bg: String) {
        fill.alpha = 255
        fill.style = Paint.Style.FILL
        fill.color = WbStyle.bgColor(bg).toInt()
        val pw = Wb.PAGE_W.toFloat()
        val ph = Wb.PAGE_H.toFloat()
        c.drawRect(0f, 0f, pw, ph, fill)
        ui.style = Paint.Style.STROKE
        ui.pathEffect = null
        ui.alpha = 255
        when (bg) {
            "dots" -> {
                fill.color = 0xFFB8C2CF.toInt()
                var y = 40f
                while (y < ph) {
                    var x = 40f
                    while (x < pw) { c.drawCircle(x, y, 2.2f, fill); x += 40f }
                    y += 40f
                }
            }
            "graph" -> {
                // Graph paper: a fine 20-unit grid with a darker line every 100 units.
                ui.color = 0xFFE4E9F0.toInt(); ui.strokeWidth = 1f
                var v = 20
                while (v < Wb.PAGE_W) { if (v % 100 != 0) c.drawLine(v.toFloat(), 0f, v.toFloat(), ph, ui); v += 20 }
                v = 20
                while (v < Wb.PAGE_H) { if (v % 100 != 0) c.drawLine(0f, v.toFloat(), pw, v.toFloat(), ui); v += 20 }
                ui.color = 0xFFB9C6D6.toInt(); ui.strokeWidth = 1.6f
                v = 100
                while (v < Wb.PAGE_W) { c.drawLine(v.toFloat(), 0f, v.toFloat(), ph, ui); v += 100 }
                v = 100
                while (v < Wb.PAGE_H) { c.drawLine(0f, v.toFloat(), pw, v.toFloat(), ui); v += 100 }
            }
            "grid", "lined" -> {
                ui.color = if (bg == "grid") 0xFFD6DDE6.toInt() else 0xFFC9D7EE.toInt()
                ui.strokeWidth = 1.5f
                var y = 60f
                while (y < ph) { c.drawLine(0f, y, pw, y, ui); y += 60f }
                if (bg == "grid") {
                    var x = 60f
                    while (x < pw) { c.drawLine(x, 0f, x, ph, ui); x += 60f }
                }
                if (bg == "lined") { ui.color = 0xFFF2A7A7.toInt(); c.drawLine(120f, 0f, 120f, ph, ui) }
            }
        }
    }

    /** Midpoint-smoothed path through the points (web drawItem stroke). */
    private fun strokePath(p: IntArray): Path {
        val n = p.size
        val path = Path()
        path.moveTo(p[0].toFloat(), p[1].toFloat())
        var i = 2
        while (i + 3 < n) {
            path.quadTo(p[i].toFloat(), p[i + 1].toFloat(), (p[i] + p[i + 2]) / 2f, (p[i + 1] + p[i + 3]) / 2f)
            i += 2
        }
        if (n >= 4) path.lineTo(p[n - 2].toFloat(), p[n - 1].toFloat())
        return path
    }

    /** Stylus stroke: one smoothed segment per point, width from pressure (web drawPressureStroke). */
    private fun drawPressure(c: Canvas, p: IntArray, pr: IntArray, w: Float) {
        val n = p.size / 2
        if (n == 1) {
            fill.style = Paint.Style.FILL
            fill.color = stroke.color; fill.alpha = stroke.alpha
            c.drawCircle(p[0].toFloat(), p[1].toFloat(), WbStyle.widthAt(w, pr[0]) / 2, fill)
            return
        }
        var sx = p[0].toFloat()
        var sy = p[1].toFloat()
        val seg = Path()
        for (i in 1 until n - 1) {
            val mx = (p[2 * i] + p[2 * i + 2]) / 2f
            val my = (p[2 * i + 1] + p[2 * i + 3]) / 2f
            stroke.strokeWidth = WbStyle.widthAt(w, pr[i])
            seg.reset()
            seg.moveTo(sx, sy)
            seg.quadTo(p[2 * i].toFloat(), p[2 * i + 1].toFloat(), mx, my)
            c.drawPath(seg, stroke)
            sx = mx
            sy = my
        }
        stroke.strokeWidth = WbStyle.widthAt(w, pr[n - 1])
        c.drawLine(sx, sy, p[2 * n - 2].toFloat(), p[2 * n - 1].toFloat(), stroke)
    }

    private fun drawStroke(c: Canvas, s: Item.Stroke, pts: IntArray = s.pts.toArray(), pr: IntArray? = s.pr?.toArray()) {
        stroke.color = parse(s.c)
        stroke.alpha = if (s.tool == "hl") 89 else 255
        stroke.strokeCap = if (s.tool == "hl") Paint.Cap.BUTT else Paint.Cap.ROUND
        stroke.strokeWidth = s.w.toFloat()
        stroke.pathEffect = null
        if (pr != null && s.tool == "pen" && pr.size == pts.size / 2) {
            drawPressure(c, pts, pr, s.w.toFloat())
        } else if (pts.size == 2) {
            fill.style = Paint.Style.FILL
            fill.color = stroke.color; fill.alpha = stroke.alpha
            c.drawCircle(pts[0].toFloat(), pts[1].toFloat(), s.w / 2f, fill)
        } else if (pts.size >= 4) {
            c.drawPath(strokePath(pts), stroke)
        }
        stroke.strokeCap = Paint.Cap.ROUND
        fill.alpha = 255
    }

    private fun drawShape(c: Canvas, k: String, col: Int, w: Float, x1: Float, y1: Float, x2: Float, y2: Float, filled: Boolean) {
        stroke.color = col; stroke.alpha = 255; stroke.strokeWidth = w; stroke.pathEffect = null
        fill.style = Paint.Style.FILL
        if (k == "line" || k == "arrow") {
            c.drawLine(x1, y1, x2, y2, stroke)
            if (k == "arrow") {
                // Filled head, as the web draws it.
                val a = atan2((y2 - y1).toDouble(), (x2 - x1).toDouble())
                val len = max(14f, w * 4)
                val head = Path()
                head.moveTo(x2, y2)
                head.lineTo((x2 - len * cos(a - 0.45)).toFloat(), (y2 - len * sin(a - 0.45)).toFloat())
                head.lineTo((x2 - len * cos(a + 0.45)).toFloat(), (y2 - len * sin(a + 0.45)).toFloat())
                head.close()
                fill.color = col; fill.alpha = 255
                c.drawPath(head, fill)
            }
            return
        }
        val path = Path()
        when (k) {
            "rect" -> path.addRect(min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2), Path.Direction.CW)
            "ellipse" -> path.addOval(min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2), Path.Direction.CW)
            else -> {
                val t = WbGeom.triPoints(Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2))
                path.moveTo(t[0].first.toFloat(), t[0].second.toFloat())
                path.lineTo(t[1].first.toFloat(), t[1].second.toFloat())
                path.lineTo(t[2].first.toFloat(), t[2].second.toFloat())
                path.close()
            }
        }
        if (filled) {
            fill.color = col; fill.alpha = 56
            c.drawPath(path, fill)
            fill.alpha = 255
        }
        c.drawPath(path, stroke)
    }

    private fun drawItem(c: Canvas, it: Item) {
        when (it) {
            is Item.Stroke -> drawStroke(c, it)
            is Item.Shape -> drawShape(c, it.k, parse(it.c), it.w.toFloat(), it.x1.toFloat(), it.y1.toFloat(), it.x2.toFloat(), it.y2.toFloat(), it.fl)
            is Item.Text -> {
                text.color = parse(it.c)
                text.textSize = it.size.toFloat()
                // Web: textBaseline 'top'.
                var y = it.y - text.ascent()
                for (line in it.text.split('\n')) { c.drawText(line, it.x.toFloat(), y, text); y += it.size * 1.25f }
            }
            is Item.Image -> {
                val bmp = image(it)
                if (bmp != null) c.drawBitmap(bmp, null, RectF(it.x.toFloat(), it.y.toFloat(), (it.x + it.w).toFloat(), (it.y + it.h).toFloat()), null)
            }
        }
    }

    private fun image(it: Item.Image): Bitmap? {
        val key = it.id + ":" + it.src.length
        images.get(key)?.let { b -> return b }
        return try {
            val raw = Base64.decode(it.src.substringAfter(","), Base64.DEFAULT)
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(raw, 0, raw.size, o)
            var sample = 1
            while (o.outWidth / (sample * 2) >= 1600 || o.outHeight / (sample * 2) >= 1600) sample *= 2
            BitmapFactory.decodeByteArray(raw, 0, raw.size, BitmapFactory.Options().apply { inSampleSize = sample })?.also { b -> images.put(key, b) }
        } catch (_: Exception) {
            null
        }
    }

    /** Page items (minus [skip]) into [c], through the view transform. */
    private fun drawPage(c: Canvas, p: Page, skip: Set<String>) {
        c.drawColor(OUTSIDE)
        c.save()
        c.translate(tx, ty)
        c.scale(scale, scale)
        c.clipRect(0f, 0f, Wb.PAGE_W.toFloat(), Wb.PAGE_H.toFloat())
        drawBackground(c, p.bg)
        for (it in p.items) if (it.id !in skip) drawItem(c, it)
        c.restore()
    }

    /** One page at full size (export): 1920×1080. */
    fun renderPage(p: Page): Bitmap {
        val bmp = Bitmap.createBitmap(Wb.PAGE_W, Wb.PAGE_H, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        drawBackground(c, p.bg)
        for (it in p.items) drawItem(c, it)
        return bmp
    }

    override fun onDraw(canvas: Canvas) {
        val h = host() ?: return
        if (width <= 0 || height <= 0) return
        val pg = h.doc.currentPage()
        val now = System.currentTimeMillis()
        // Moving parts are drawn live; the rest comes from the cached layer.
        val live = HashSet(h.hotIds(now))
        drawingId?.let { live.add(it) }
        val xf = selXf
        if (xf != null) live.addAll(selection)
        val key = "${pg.id}|${pg.bg}|${h.version}|${live.sorted().joinToString(",")}|$scale|$tx|$ty|${width}x$height"
        val l = layer?.takeIf { it.width == width && it.height == height }
            ?: Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { layer = it; layerKey = "" }
        if (key != layerKey) {
            drawPage(Canvas(l), pg, live)
            layerKey = key
        }
        canvas.drawBitmap(l, 0f, 0f, null)

        canvas.save()
        canvas.translate(tx, ty)
        canvas.scale(scale, scale)
        canvas.clipRect(0f, 0f, Wb.PAGE_W.toFloat(), Wb.PAGE_H.toFloat())
        val selSet = selection.toHashSet()
        for (it in pg.items) {
            if (it.id !in live) continue
            drawItem(canvas, if (xf != null && it.id in selSet) WbGeom.transform(it, xf) else it)
        }
        drawTail(canvas, pg)
        // Shape / band / area preview.
        val s0 = shapeStart
        val s1 = shapeEnd
        if (s0 != null && s1 != null) {
            val k = kindOf(tool)
            if (tool == Tool.AREA || tool == Tool.SELECT) {
                ui.style = Paint.Style.STROKE; ui.pathEffect = null; ui.alpha = 255
                ui.color = if (tool == Tool.AREA) 0xFFE53935.toInt() else 0xFF3B82F6.toInt()
                ui.strokeWidth = 2 * density / scale
                canvas.drawRect(min(s0.first, s1.first).toFloat(), min(s0.second, s1.second).toFloat(), max(s0.first, s1.first).toFloat(), max(s0.second, s1.second).toFloat(), ui)
            } else if (k != null) {
                drawShape(canvas, k, parse(color), penWidth.toFloat(), s0.first.toFloat(), s0.second.toFloat(), s1.first.toFloat(), s1.second.toFloat(), fillShapes && k in Wb.FILLABLE)
            }
        }
        canvas.restore()
        drawSelectionFrame(canvas, xf)
        drawLaser(canvas, now)
    }

    /** The growing stroke's points that have not left yet. */
    private fun drawTail(canvas: Canvas, pg: Page) {
        val b = batcher ?: return
        val dId = drawingId ?: return
        if (snapped || b.peek().size == 0) return
        val s = pg.items.firstOrNull { it.id == dId } as? Item.Stroke ?: return
        if (s.pts.size < 2) return
        val pend = b.peek().toArray()
        val pts = IntArray(2 + pend.size)
        pts[0] = s.pts[s.pts.size - 2]
        pts[1] = s.pts[s.pts.size - 1]
        System.arraycopy(pend, 0, pts, 2, pend.size)
        val prs = s.pr
        val pr = if (prs == null) null else {
            val pp = b.peekPressure().toArray()
            IntArray(1 + pp.size).also { out ->
                out[0] = if (prs.size > 0) prs[prs.size - 1] else 50
                System.arraycopy(pp, 0, out, 1, pp.size)
            }
        }
        drawStroke(canvas, s, pts, pr)
    }

    /** Selection frame and resize handle (screen units). */
    private fun drawSelectionFrame(canvas: Canvas, xf: WbXf?) {
        val b0 = selectionBox()
        if (b0 == null) {
            onSelectionFrame?.invoke(null)
            return
        }
        val bx = if (xf != null) WbGeom.Box((b0.x - xf.ox) * xf.s + xf.ox + xf.dx, (b0.y - xf.oy) * xf.s + xf.oy + xf.dy, b0.w * xf.s, b0.h * xf.s) else b0
        val x = (bx.x * scale + tx).toFloat()
        val y = (bx.y * scale + ty).toFloat()
        val w = (bx.w * scale).toFloat()
        val hh = (bx.h * scale).toFloat()
        val pad = 4 * density
        ui.style = Paint.Style.STROKE; ui.color = 0xFF3B82F6.toInt(); ui.alpha = 255; ui.strokeWidth = 1.5f * density; ui.pathEffect = dashed
        canvas.drawRect(x - pad, y - pad, x + w + pad, y + hh + pad, ui)
        ui.pathEffect = null
        val hs = 14 * density
        val hx = x + w - 3 * density
        val hy = y + hh - 3 * density
        fill.style = Paint.Style.FILL; fill.color = Color.WHITE; fill.alpha = 255
        canvas.drawRect(hx, hy, hx + hs, hy + hs, fill)
        canvas.drawRect(hx, hy, hx + hs, hy + hs, ui)
        onSelectionFrame?.invoke(if (xf == null) RectF(x, y, x + w, y + hh) else null)
    }

    /** Laser trail: keep animating while it fades (screen-constant size, web drawLaser). */
    private fun drawLaser(canvas: Canvas, now: Long) {
        if (!laser.prune(now)) return
        canvas.save()
        canvas.translate(tx, ty)
        canvas.scale(scale, scale)
        ui.style = Paint.Style.STROKE; ui.pathEffect = null; ui.color = LASER; ui.strokeCap = Paint.Cap.ROUND
        ui.strokeWidth = 5 * density / scale
        val pts = laser.pts
        for (i in 1 until pts.size) {
            val a = pts[i - 1]
            val b = pts[i]
            if (b.t - a.t > 250) continue
            ui.alpha = (max(0f, 1f - (now - b.t).toFloat() / Wb.LASER_MS) * 0.85f * 255).toInt()
            canvas.drawLine(a.x.toFloat(), a.y.toFloat(), b.x.toFloat(), b.y.toFloat(), ui)
        }
        val head = pts[pts.size - 1]
        val alpha = max(0f, 1f - (now - head.t).toFloat() / Wb.LASER_MS)
        fill.style = Paint.Style.FILL
        fill.color = LASER; fill.alpha = (alpha * 255).toInt()
        canvas.drawCircle(head.x.toFloat(), head.y.toFloat(), 8 * density / scale, fill)
        fill.color = Color.WHITE; fill.alpha = (alpha * 255).toInt()
        canvas.drawCircle(head.x.toFloat(), head.y.toFloat(), 3 * density / scale, fill)
        fill.alpha = 255
        ui.alpha = 255
        canvas.restore()
        postInvalidateOnAnimation()
    }

    private fun kindOf(t: Tool) = when (t) {
        Tool.LINE -> "line"; Tool.ARROW -> "arrow"; Tool.RECT -> "rect"; Tool.ELLIPSE -> "ellipse"; Tool.TRI -> "tri"; else -> null
    }

    // ---- selection ----
    private fun selectedItems(): List<Item> {
        val h = host() ?: return emptyList()
        val set = selection.toHashSet()
        return h.doc.currentPage().items.filter { it.id in set }
    }

    private fun selectionBox(): WbGeom.Box? = if (tool == Tool.SELECT) WbGeom.union(selectedItems()) else null

    private fun setSelection(ids: List<String>) {
        if (ids == selection) return
        selection = ids
        onSelection?.invoke(ids.isNotEmpty())
        invalidate()
    }

    val hasSelection get() = selection.isNotEmpty()

    fun deleteSelection() {
        val h = host() ?: return
        if (selection.isEmpty()) return
        h.local(listOf(WbOps.del(h.doc.currentPage().id, selection)))
        setSelection(emptyList())
        onLocalChange?.invoke()
    }

    fun duplicateSelection() {
        val h = host() ?: return
        val pid = h.doc.currentPage().id
        val copies = selectedItems().mapNotNull { src ->
            Item.clean(src.toJson().put("id", Wb.newId("t")).put("by", me))?.let { WbGeom.transform(it, WbXf(1.0, 0.0, 0.0, 30.0, 30.0)) }
        }
        if (copies.isEmpty()) return
        h.local(copies.map { WbOps.add(pid, it) })
        setSelection(copies.map { it.id })
        onLocalChange?.invoke()
    }

    /** Insert a picture in the middle of the page, selected and ready to move (web insertImage). */
    fun insertImage(src: Bitmap) {
        val h = host() ?: return
        val k = min(1f, 1280f / max(src.width, src.height))
        val bmp = if (k < 1f) Bitmap.createScaledBitmap(src, max(1, (src.width * k).toInt()), max(1, (src.height * k).toInt()), true) else src
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 80, out)
        val url = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        val fit = min(1f, min(Wb.PAGE_W * 0.7f / bmp.width, Wb.PAGE_H * 0.7f / bmp.height))
        val w = max(1, (bmp.width * fit).toInt())
        val hh = max(1, (bmp.height * fit).toInt())
        val id = Wb.newId("t")
        h.local(listOf(WbOps.add(h.doc.currentPage().id, Item.Image(id, me, (Wb.PAGE_W - w) / 2, (Wb.PAGE_H - hh) / 2, w, hh, url))))
        tool = Tool.SELECT
        setSelection(listOf(id))
        onLocalChange?.invoke()
    }

    // ---- input ----
    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        val h = host() ?: return false
        val pg = h.doc.currentPage()
        when (e.actionMasked) {
            MotionEvent.ACTION_POINTER_DOWN -> {
                // Second finger: pinch-zoom / two-finger pan. A stroke already
                // started is kept as drawn so far.
                endStroke()
                shapeStart = null; shapeEnd = null; selXf = null; selMode = null; panFrom = null
                if (e.pointerCount >= 2) pinch = floatArrayOf(e.getX(0), e.getY(0), e.getX(1), e.getY(1))
                invalidate()
                return true
            }
            MotionEvent.ACTION_POINTER_UP -> {
                if (e.pointerCount <= 2) pinch = null
                return true
            }
        }
        val p0 = pinch
        if (p0 != null) {
            if (e.actionMasked == MotionEvent.ACTION_MOVE && e.pointerCount >= 2) {
                zp = ZoomPan.pinch(zp, p0[0], p0[1], p0[2], p0[3], e.getX(0), e.getY(0), e.getX(1), e.getY(1), width.toFloat(), height.toFloat(), MIN_ZOOM)
                pinch = floatArrayOf(e.getX(0), e.getY(0), e.getX(1), e.getY(1))
                onZoom?.invoke(zp.s)
                invalidate()
            }
            if (e.actionMasked == MotionEvent.ACTION_UP || e.actionMasked == MotionEvent.ACTION_CANCEL) pinch = null
            return true
        }
        val (x, y) = toPage(e.x, e.y)
        val toolType = e.getToolType(0)
        val stylus = toolType == MotionEvent.TOOL_TYPE_STYLUS || toolType == MotionEvent.TOOL_TYPE_ERASER
        if (stylus) lastStylusAt = SystemClock.uptimeMillis()
        // Palm rejection: right after stylus input, a finger pans instead of drawing.
        val palm = toolType == MotionEvent.TOOL_TYPE_FINGER && SystemClock.uptimeMillis() - lastStylusAt < PALM_MS
        val t = when {
            toolType == MotionEvent.TOOL_TYPE_ERASER -> Tool.ERASER
            palm -> Tool.HAND
            else -> tool
        }
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                when (t) {
                    Tool.HAND -> panFrom = Triple(e.x, e.y, zp)
                    Tool.LASER -> laserAt(x, y)
                    Tool.PEN, Tool.HIGHLIGHT -> startStroke(pg, t, x, y, stylus, e.pressure)
                    Tool.ERASER -> eraseAt(pg, x, y)
                    Tool.TEXT -> {
                        onText(x.toInt(), y.toInt())
                        return true
                    }
                    Tool.SELECT -> selectDown(pg, x, y)
                    else -> { shapeStart = x to y; shapeEnd = shapeStart }
                }
                invalidate()
            }
            MotionEvent.ACTION_MOVE -> {
                when (t) {
                    Tool.HAND -> panFrom?.let { (sx, sy, z0) ->
                        zp = ZoomPan.panBy(z0, e.x - sx, e.y - sy, width.toFloat(), height.toFloat(), MIN_ZOOM)
                        invalidate()
                    }
                    Tool.LASER -> laserAt(x, y)
                    Tool.PEN, Tool.HIGHLIGHT -> moveStroke(e, x, y)
                    Tool.ERASER -> eraseAt(pg, x, y)
                    Tool.SELECT -> selectMove(x, y)
                    else -> if (shapeStart != null) { shapeEnd = x to y; invalidate() }
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                when (t) {
                    Tool.HAND -> panFrom = null
                    Tool.PEN, Tool.HIGHLIGHT -> endStroke()
                    Tool.SELECT -> selectUp(pg, x, y)
                    Tool.AREA -> {
                        val s = shapeStart
                        shapeStart = null; shapeEnd = null
                        if (s != null) {
                            val ids = WbGeom.inRect(pg, s.first, s.second, x, y) { true }
                            if (ids.isNotEmpty()) { h.local(listOf(WbOps.del(pg.id, ids))); onLocalChange?.invoke() }
                        }
                    }
                    else -> finishShape(pg, t, x, y)
                }
                invalidate()
            }
        }
        return true
    }

    private fun startStroke(pg: Page, t: Tool, x: Double, y: Double, stylus: Boolean, pressure: Float) {
        val h = host() ?: return
        val id = Wb.newId("t")
        // A stylus records pressure (pen strokes only; the highlighter stays even).
        val withPressure = t == Tool.PEN && stylus
        val w = if (t == Tool.HIGHLIGHT) WbStyle.highlighterWidth(penWidth) else penWidth
        val pts = IntArrayList().also { it.add(Math.floor(x + 0.5).toInt()); it.add(Math.floor(y + 0.5).toInt()) }
        val pr = if (withPressure) IntArrayList().also { it.add(Wb.pressurePct(pressure)) } else null
        h.local(listOf(WbOps.add(pg.id, Item.Stroke(id, me, if (t == Tool.HIGHLIGHT) "hl" else "pen", color, w, pts, pr))))
        batcher = PointBatcher(pg.id, id, withPressure)
        drawingId = id
        snapped = false
        lastFlush = SystemClock.uptimeMillis()
        armSnap(x, y, force = true)
    }

    private fun moveStroke(e: MotionEvent, x: Double, y: Double) {
        val b = batcher ?: return
        if (snapped) return
        // Every sample the hardware delivered since the last frame.
        for (i in 0 until e.historySize) {
            val (hx, hy) = toPage(e.getHistoricalX(i), e.getHistoricalY(i))
            b.push(hx, hy, e.getHistoricalPressure(i))
        }
        b.push(x, y, e.pressure)
        val now = SystemClock.uptimeMillis()
        if (now - lastFlush >= Wb.BATCH_MS) flushPoints() else { removeCallbacks(flush); postDelayed(flush, Wb.BATCH_MS) }
        armSnap(x, y)
        invalidate()
    }

    private fun finishShape(pg: Page, t: Tool, x: Double, y: Double) {
        val h = host() ?: return
        val s = shapeStart
        val k = kindOf(t)
        shapeStart = null; shapeEnd = null
        if (s == null || k == null || hypot(x - s.first, y - s.second) < 3) return
        val item = Item.Shape(
            k, Wb.newId("t"), me, color, penWidth,
            Math.floor(s.first + 0.5).toInt(), Math.floor(s.second + 0.5).toInt(), Math.floor(x + 0.5).toInt(), Math.floor(y + 0.5).toInt(),
            fillShapes && k in Wb.FILLABLE,
        )
        h.local(listOf(WbOps.add(pg.id, item)))
        onLocalChange?.invoke()
    }

    private fun endStroke() {
        removeCallbacks(snap)
        if (batcher == null) return
        if (!snapped) flushPoints()
        batcher = null
        drawingId = null
        onLocalChange?.invoke()
    }

    private fun eraseAt(pg: Page, x: Double, y: Double) {
        val h = host() ?: return
        val r = 10.0 * density / scale
        val ids = pg.items.filter { WbGeom.hit(it, x, y, r) }.map { it.id }
        if (ids.isEmpty()) return
        h.local(listOf(WbOps.del(pg.id, ids)))
        onLocalChange?.invoke()
        invalidate()
    }

    private fun laserAt(x: Double, y: Double) {
        val px = Math.floor(x + 0.5).toInt()
        val py = Math.floor(y + 0.5).toInt()
        laser.add(intArrayOf(px, py))
        if (laserBuf.size == 0) postDelayed(sendLaser, LASER_SEND_MS)
        laserBuf.add(px); laserBuf.add(py)
        invalidate()
    }

    private fun flushPoints() {
        removeCallbacks(flush)
        val op = batcher?.flush() ?: return
        lastFlush = SystemClock.uptimeMillis()
        host()?.local(listOf(op), record = false)
        invalidate()
    }

    /** Hold-to-snap: re-arm while the pen moves; fires after SNAP_HOLD_MS still. */
    private fun armSnap(x: Double, y: Double, force: Boolean = false) {
        if (tool != Tool.PEN || snapped) return
        if (!force && hypot(x - holdX, y - holdY) < WbRecognize.SNAP_STILL_PX) return
        holdX = x; holdY = y
        removeCallbacks(snap)
        postDelayed(snap, WbRecognize.SNAP_HOLD_MS)
    }

    private fun trySnap() {
        val h = host() ?: return
        val id = drawingId ?: return
        if (batcher == null || snapped) return
        flushPoints()
        val pg = h.doc.currentPage()
        val s = pg.items.firstOrNull { it.id == id } as? Item.Stroke ?: return
        val shape = WbRecognize.recognize(s.pts.toArray()) ?: return
        snapped = true
        val item = Item.Shape(shape.k, Wb.newId("t"), me, s.c, s.w, shape.x1, shape.y1, shape.x2, shape.y2, fillShapes && shape.k in Wb.FILLABLE)
        // One undo step back to the free-hand stroke (a second undo removes it).
        h.local(listOf(WbOps.del(pg.id, listOf(id)), WbOps.add(pg.id, item)))
        onLocalChange?.invoke()
        invalidate()
    }

    private fun selectDown(pg: Page, x: Double, y: Double) {
        val pad = 10.0 * density / scale
        val b = selectionBox()
        if (b != null) {
            val hx = b.x + b.w
            val hy = b.y + b.h
            if (abs(x - hx) <= 18 * density / scale && abs(y - hy) <= 18 * density / scale) { selMode = "scale"; selStart = x to y; return }
            if (x >= b.x - pad && x <= hx + pad && y >= b.y - pad && y <= hy + pad) { selMode = "move"; selStart = x to y; return }
        }
        // Pressing on an item selects it and starts moving it straight away.
        val hit = pg.items.lastOrNull { WbGeom.hit(it, x, y, pad) }
        if (hit != null) {
            setSelection(listOf(hit.id))
            selMode = "move"; selStart = x to y
            return
        }
        setSelection(emptyList())
        selMode = "band"; selStart = x to y
        shapeStart = x to y; shapeEnd = shapeStart
    }

    private fun selectMove(x: Double, y: Double) {
        val s = selStart ?: return
        when (selMode) {
            "band" -> shapeEnd = x to y
            "move" -> selXf = WbXf(1.0, 0.0, 0.0, Math.floor(x - s.first + 0.5), Math.floor(y - s.second + 0.5))
            "scale" -> {
                val b = WbGeom.union(selectedItems()) ?: return
                val sx = (x - b.x) / max(1.0, b.w)
                val sy = (y - b.y) / max(1.0, b.h)
                selXf = WbXf(min(10.0, max(0.1, max(sx, sy))), b.x, b.y, 0.0, 0.0)
            }
        }
        invalidate()
    }

    private fun selectUp(pg: Page, x: Double, y: Double) {
        val h = host() ?: return
        val s = selStart
        val mode = selMode
        selStart = null; selMode = null
        if (mode == "band") {
            shapeStart = null; shapeEnd = null
            if (s != null && hypot(x - s.first, y - s.second) > 4 * density / scale) setSelection(WbGeom.inRect(pg, s.first, s.second, x, y) { true })
            return
        }
        val xf = selXf
        selXf = null
        if (xf != null && (xf.s != 1.0 || xf.dx != 0.0 || xf.dy != 0.0) && selection.isNotEmpty()) {
            h.local(listOf(WbOps.xf(pg.id, selection, xf.s, Math.floor(xf.ox + 0.5).toInt(), Math.floor(xf.oy + 0.5).toInt(), xf.dx.toInt(), xf.dy.toInt())))
            onLocalChange?.invoke()
        }
    }

    /** After remote / programmatic changes. */
    fun changed() {
        if (selection.isNotEmpty()) {
            val live = selectedItems().map { it.id }
            if (live.size != selection.size) setSelection(live)
        }
        invalidate()
    }

    companion object {
        /** The teacher may zoom out to half size (web minZoom in edit mode). */
        const val MIN_ZOOM = 0.5f
        private const val OUTSIDE = 0xFF0B0F14.toInt()
        private const val LASER = 0xFFEF4444.toInt()
        private const val LASER_SEND_MS = 50L
        /** Finger input right after a stylus pans instead of drawing (palm rejection). */
        private const val PALM_MS = 1500L
    }
}
