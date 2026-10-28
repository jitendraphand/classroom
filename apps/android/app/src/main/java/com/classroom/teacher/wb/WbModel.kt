package com.classroom.teacher.wb

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Base64
import java.util.zip.Deflater
import java.util.zip.Inflater
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/**
 * Kotlin port of the web whiteboard model and wire format
 * (apps/web/src/lib/whiteboard/model.ts + codec.ts, also used by the Windows
 * teacher app). JSON shapes, limits and rules are identical, so web and
 * Windows students render the same pages. Pure JVM code: unit-tested.
 */
object Wb {
    const val TOPIC = "wb"
    const val PAGE_W = 1920
    const val PAGE_H = 1080
    const val MAX_PAGES = 50
    const val MAX_ITEMS_PER_PAGE = 4000
    const val MAX_POINTS_PER_STROKE = 4000
    const val BATCH_MS = 30L
    const val CHUNK_CHARS = 12_000
    /** Debounce for storing the snapshot on the server (web SNAP_STORE_MS). */
    const val SNAP_STORE_MS = 5000L
    /** A stroke counts as growing for this long after its last points (web HOT_MS). */
    const val HOT_MS = 1500L
    val BACKGROUNDS = listOf("white", "grid", "lined", "dots", "graph", "black")
    val SHAPE_KINDS = listOf("line", "arrow", "rect", "ellipse", "tri")
    val FILLABLE = setOf("rect", "ellipse", "tri")
    /** Laser trail point lifetime (web LASER_MS). */
    const val LASER_MS = 900L
    val PALETTE = listOf("#111111", "#ffffff", "#e53935", "#fb8c00", "#fdd835", "#43a047", "#1e88e5", "#8e24aa")

    private val COLOR_RE = Regex("^#[0-9a-fA-F]{6}$")
    private val ID_RE = Regex("^[A-Za-z0-9_-]{1,40}$")
    private val IMG_RE = Regex("^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$")

    fun validId(id: String) = ID_RE.matches(id)

    fun newId(prefix: String = ""): String {
        val chars = "abcdefghijklmnopqrstuvwxyz0123456789"
        val r = (1..8).map { chars.random() }.joinToString("") + java.lang.Long.toString(System.currentTimeMillis(), 36).takeLast(4)
        return (prefix + r).take(40)
    }

    fun inkFor(bg: String) = if (bg == "black") "#ffffff" else "#111111"

    /** JS Math.round on a number, clamped. Non-numbers clamp to lo (web clampN). */
    fun clampN(n: Any?, lo: Int, hi: Int): Int {
        val d = when (n) {
            is Number -> n.toDouble()
            is String -> n.toDoubleOrNull() ?: Double.NaN
            is Boolean -> if (n) 1.0 else 0.0
            else -> Double.NaN
        }
        if (d.isNaN() || d.isInfinite()) return lo
        val v = Math.floor(d + 0.5).roundToLong()
        return min(hi.toLong(), max(lo.toLong(), v)).toInt()
    }

    /** Stylus pressure list: 0–100 integers, at most [maxLen] (web cleanPr). Null when absent or empty. */
    fun cleanPr(raw: Any?, maxLen: Int = MAX_POINTS_PER_STROKE): IntArray? {
        val arr = raw as? JSONArray ?: return null
        if (arr.length() == 0) return null
        return IntArray(min(arr.length(), maxLen)) { clampN(arr.opt(it), 0, 100) }
    }

    /** Pressure 0–1 → the stored 0–100 integer (web pressurePct). */
    fun pressurePct(p: Float): Int = clampN(if (p.isFinite()) p * 100.0 else 50.0, 0, 100)

    fun cleanPts(raw: Any?, maxLen: Int = MAX_POINTS_PER_STROKE * 2): IntArray? {
        val arr = raw as? JSONArray ?: return null
        val out = IntArrayList()
        var i = 0
        while (i + 1 < arr.length() && out.size < maxLen) {
            out.add(clampN(arr.opt(i), -PAGE_W, PAGE_W * 2))
            out.add(clampN(arr.opt(i + 1), -PAGE_H, PAGE_H * 2))
            i += 2
        }
        return out.toArray()
    }
}

/** Growable int list without boxing (stroke points). */
class IntArrayList(cap: Int = 16) {
    var data = IntArray(cap)
    var size = 0
        private set
    fun add(v: Int) {
        if (size == data.size) data = data.copyOf(max(16, size * 2))
        data[size++] = v
    }
    fun addAll(v: IntArray) { for (x in v) add(x) }
    fun clear() { size = 0 }
    operator fun get(i: Int) = data[i]
    fun toArray(): IntArray = data.copyOf(size)
    fun copy(): IntArrayList = IntArrayList(max(16, size)).also { it.addAll(toArray()) }
}

sealed class Item {
    abstract val id: String
    abstract val by: String
    abstract fun toJson(): JSONObject

    /** [pr] = stylus pressure per point (pen strokes only), aligned with [pts]. */
    class Stroke(override val id: String, override val by: String, val tool: String, val c: String, val w: Int, val pts: IntArrayList, val pr: IntArrayList? = null) : Item() {
        override fun toJson(): JSONObject {
            val o = JSONObject().put("k", "stroke").put("id", id).put("by", by).put("tool", tool).put("c", c).put("w", w)
                .put("pts", JSONArray().also { a -> for (i in 0 until pts.size) a.put(pts[i]) })
            if (pr != null) o.put("pr", JSONArray().also { a -> for (i in 0 until pr.size) a.put(pr[i]) })
            return o
        }
    }
    /** [fl] = filled (rect, ellipse, triangle). */
    class Shape(val k: String, override val id: String, override val by: String, val c: String, val w: Int, val x1: Int, val y1: Int, val x2: Int, val y2: Int, val fl: Boolean = false) : Item() {
        override fun toJson(): JSONObject {
            val o = JSONObject().put("k", k).put("id", id).put("by", by).put("c", c).put("w", w)
                .put("x1", x1).put("y1", y1).put("x2", x2).put("y2", y2)
            if (fl) o.put("fl", 1)
            return o
        }
    }
    class Text(override val id: String, override val by: String, val c: String, val size: Int, val x: Int, val y: Int, val text: String) : Item() {
        override fun toJson() = JSONObject().put("k", "text").put("id", id).put("by", by).put("c", c).put("size", size).put("x", x).put("y", y).put("text", text)
    }
    class Image(override val id: String, override val by: String, val x: Int, val y: Int, val w: Int, val h: Int, val src: String) : Item() {
        override fun toJson() = JSONObject().put("k", "img").put("id", id).put("by", by).put("x", x).put("y", y).put("w", w).put("h", h).put("src", src)
    }

    companion object {
        /** Validate / normalise an item from the network (web cleanItem). Null = reject. */
        fun clean(raw: Any?): Item? {
            val o = raw as? JSONObject ?: return null
            val id = o.opt("id")?.toString() ?: ""
            if (o.isNull("id") || !Wb.validId(id)) return null
            val by = (if (o.isNull("by")) "" else o.opt("by")?.toString() ?: "").take(80)
            val cRaw = o.opt("c")?.toString() ?: ""
            val c = if (Regex("^#[0-9a-fA-F]{6}$").matches(cRaw)) cRaw else "#111111"
            return when (val k = o.optString("k")) {
                "stroke" -> {
                    val pts = Wb.cleanPts(o.opt("pts")) ?: return null
                    val tool = if (o.optString("tool") == "hl") "hl" else "pen"
                    // Pressure only for pen strokes, exactly one value per point.
                    val pr = if (tool == "pen") Wb.cleanPr(o.opt("pr"), pts.size / 2)?.takeIf { it.size == pts.size / 2 } else null
                    Stroke(
                        id, by, tool, c, Wb.clampN(o.opt("w"), 1, 80), IntArrayList(max(16, pts.size)).also { it.addAll(pts) },
                        pr?.let { a -> IntArrayList(max(16, a.size)).also { it.addAll(a) } },
                    )
                }
                "line", "arrow", "rect", "ellipse", "tri" -> Shape(
                    k, id, by, c, Wb.clampN(o.opt("w"), 1, 80),
                    Wb.clampN(o.opt("x1"), -Wb.PAGE_W, Wb.PAGE_W * 2), Wb.clampN(o.opt("y1"), -Wb.PAGE_H, Wb.PAGE_H * 2),
                    Wb.clampN(o.opt("x2"), -Wb.PAGE_W, Wb.PAGE_W * 2), Wb.clampN(o.opt("y2"), -Wb.PAGE_H, Wb.PAGE_H * 2),
                    fl = o.opt("fl") == 1 && k in Wb.FILLABLE,
                )
                "text" -> {
                    val text = (if (o.isNull("text")) "" else o.opt("text")?.toString() ?: "").take(2000)
                    if (text.isEmpty()) null
                    else Text(id, by, c, Wb.clampN(o.opt("size"), 8, 400), Wb.clampN(o.opt("x"), -Wb.PAGE_W, Wb.PAGE_W * 2), Wb.clampN(o.opt("y"), -Wb.PAGE_H, Wb.PAGE_H * 2), text)
                }
                "img" -> {
                    val src = o.optString("src")
                    if (src.length > 3_000_000 || !Regex("^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$").matches(src)) null
                    else Image(
                        id, by,
                        Wb.clampN(o.opt("x"), -Wb.PAGE_W, Wb.PAGE_W * 2), Wb.clampN(o.opt("y"), -Wb.PAGE_H, Wb.PAGE_H * 2),
                        Wb.clampN(o.opt("w"), 1, Wb.PAGE_W * 3), Wb.clampN(o.opt("h"), 1, Wb.PAGE_H * 3), src,
                    )
                }
                else -> null
            }
        }
    }
}

class Page(val id: String, var bg: String, val items: MutableList<Item> = ArrayList()) {
    fun toJson() = JSONObject().put("id", id).put("bg", bg).put("items", JSONArray().also { a -> items.forEach { a.put(it.toJson()) } })
    fun deepCopy(): Page = Page(id, bg, items.map { Item.clean(it.toJson())!! }.toMutableList())
}

class Doc(val pages: MutableList<Page>, var cur: Int) {
    fun toJson() = JSONObject().put("v", 1).put("pages", JSONArray().also { a -> pages.forEach { a.put(it.toJson()) } }).put("cur", cur)
    fun currentPage(): Page = pages[min(max(0, cur), pages.size - 1)]
    fun page(id: String) = pages.firstOrNull { it.id == id }

    companion object {
        fun empty(bg: String = "white") = Doc(mutableListOf(Page(Wb.newId("p"), bg)), 0)

        /** Validate a snapshot document (web cleanDoc). */
        fun clean(raw: Any?): Doc? {
            val o = raw as? JSONObject ?: return null
            val arr = o.optJSONArray("pages") ?: return null
            if (arr.length() == 0) return null
            val pages = ArrayList<Page>()
            for (i in 0 until min(arr.length(), Wb.MAX_PAGES)) {
                val p = arr.optJSONObject(i) ?: continue
                val id = p.opt("id")?.toString() ?: ""
                if (!Wb.validId(id)) continue
                val bg = p.optString("bg").takeIf { it in Wb.BACKGROUNDS } ?: "white"
                val items = ArrayList<Item>()
                val ia = p.optJSONArray("items")
                if (ia != null) for (j in 0 until min(ia.length(), Wb.MAX_ITEMS_PER_PAGE)) Item.clean(ia.opt(j))?.let(items::add)
                pages.add(Page(id, bg, items))
            }
            if (pages.isEmpty()) return null
            return Doc(pages, Wb.clampN(o.opt("cur"), 0, pages.size - 1))
        }
    }
}

/** Whiteboard ops (web Op), kept as validated JSON objects plus typed access. */
object WbOps {
    fun add(p: String, item: Item) = JSONObject().put("k", "add").put("p", p).put("item", item.toJson())
    fun pts(p: String, id: String, pts: IntArray, pr: IntArray? = null): JSONObject {
        val o = JSONObject().put("k", "pts").put("p", p).put("id", id).put("pts", JSONArray().also { a -> pts.forEach { a.put(it) } })
        if (pr != null) o.put("pr", JSONArray().also { a -> pr.forEach { a.put(it) } })
        return o
    }
    /** Move / resize items: every point becomes (pt - o) * s + o + d (web `xf`). */
    fun xf(p: String, ids: Collection<String>, s: Double, ox: Int, oy: Int, dx: Int, dy: Int) =
        JSONObject().put("k", "xf").put("p", p).put("ids", JSONArray(ids.toList())).put("s", s).put("ox", ox).put("oy", oy).put("dx", dx).put("dy", dy)
    fun del(p: String, ids: Collection<String>) = JSONObject().put("k", "del").put("p", p).put("ids", JSONArray(ids.toList()))
    fun clear(p: String) = JSONObject().put("k", "clear").put("p", p)
    fun bg(p: String, bg: String) = JSONObject().put("k", "bg").put("p", p).put("bg", bg)
    fun newPage(at: Int, id: String, bg: String) = JSONObject().put("k", "newpage").put("at", at).put("id", id).put("bg", bg)
    fun delPage(p: String) = JSONObject().put("k", "delpage").put("p", p)
    fun go(cur: Int) = JSONObject().put("k", "go").put("cur", cur)

    private fun ids(op: JSONObject): List<String> {
        val a = op.optJSONArray("ids") ?: return emptyList()
        return (0 until a.length()).map { a.opt(it)?.toString() ?: "" }
    }

    /** Apply one op in place (web applyOp). True when something changed. */
    fun apply(doc: Doc, op: JSONObject): Boolean {
        when (op.optString("k")) {
            "add" -> {
                val page = doc.page(op.optString("p")) ?: return false
                val item = Item.clean(op.opt("item")) ?: return false
                val i = page.items.indexOfFirst { it.id == item.id }
                when {
                    i >= 0 -> page.items[i] = item
                    page.items.size < Wb.MAX_ITEMS_PER_PAGE -> page.items.add(item)
                    else -> return false
                }
                return true
            }
            "pts" -> {
                val page = doc.page(op.optString("p")) ?: return false
                val s = page.items.firstOrNull { it.id == op.optString("id") } as? Item.Stroke ?: return false
                val pts = Wb.cleanPts(op.opt("pts"), max(0, Wb.MAX_POINTS_PER_STROKE * 2 - s.pts.size)) ?: return false
                if (pts.isEmpty()) return false
                if (s.pr != null) {
                    // Keep one pressure per point: missing values repeat the last one.
                    val add = Wb.cleanPr(op.opt("pr"), pts.size / 2) ?: IntArray(0)
                    val last = if (s.pr.size > 0) s.pr[s.pr.size - 1] else 50
                    for (i in 0 until pts.size / 2) s.pr.add(if (i < add.size) add[i] else if (add.isNotEmpty()) add[add.size - 1] else last)
                }
                s.pts.addAll(pts)
                return true
            }
            "xf" -> {
                val page = doc.page(op.optString("p")) ?: return false
                val set = ids(op).toHashSet()
                val sRaw = op.optDouble("s", 1.0)
                val t = WbXf(
                    if (sRaw.isFinite()) min(20.0, max(0.05, sRaw)) else 1.0,
                    op.optDouble("ox", 0.0).takeIf { it.isFinite() } ?: 0.0, op.optDouble("oy", 0.0).takeIf { it.isFinite() } ?: 0.0,
                    op.optDouble("dx", 0.0).takeIf { it.isFinite() } ?: 0.0, op.optDouble("dy", 0.0).takeIf { it.isFinite() } ?: 0.0,
                )
                var changed = false
                for (i in page.items.indices) {
                    if (page.items[i].id !in set) continue
                    page.items[i] = WbGeom.transform(page.items[i], t)
                    changed = true
                }
                return changed
            }
            "del" -> {
                val page = doc.page(op.optString("p")) ?: return false
                val set = ids(op).toHashSet()
                return page.items.removeAll { it.id in set }
            }
            "clear" -> {
                val page = doc.page(op.optString("p")) ?: return false
                if (page.items.isEmpty()) return false
                page.items.clear()
                return true
            }
            "bg" -> {
                val page = doc.page(op.optString("p")) ?: return false
                val bg = op.optString("bg")
                if (bg !in Wb.BACKGROUNDS) return false
                page.bg = bg
                return true
            }
            "newpage" -> {
                val id = op.optString("id")
                if (doc.pages.size >= Wb.MAX_PAGES || doc.page(id) != null || !Wb.validId(id)) return false
                val at = min(max(0, op.optInt("at")), doc.pages.size)
                val bg = op.optString("bg").takeIf { it in Wb.BACKGROUNDS } ?: "white"
                doc.pages.add(at, Page(id, bg))
                doc.cur = at
                return true
            }
            "delpage" -> {
                if (doc.pages.size <= 1) return false
                val i = doc.pages.indexOfFirst { it.id == op.optString("p") }
                if (i < 0) return false
                doc.pages.removeAt(i)
                doc.cur = min(doc.cur, doc.pages.size - 1)
                return true
            }
            "go" -> {
                val cur = min(max(0, Math.floor(op.optDouble("cur", 0.0)).toInt()), doc.pages.size - 1)
                if (cur == doc.cur) return false
                doc.cur = cur
                return true
            }
            "delBy" -> {
                val by = op.optString("by")
                var changed = false
                for (p in doc.pages) if (p.items.removeAll { it.by == by }) changed = true
                return changed
            }
        }
        return false
    }

    /** Ops a student may send: only their own pen strokes (web studentOpAllowed). */
    fun studentAllowed(op: JSONObject, identity: String, doc: Doc?): Boolean {
        return when (op.optString("k")) {
            "add" -> {
                val item = op.optJSONObject("item") ?: return false
                item.optString("k") == "stroke" && item.optString("by") == identity
            }
            "pts" -> {
                if (doc == null) return true
                doc.page(op.optString("p"))?.items?.firstOrNull { it.id == op.optString("id") }?.by == identity
            }
            "del" -> {
                if (doc == null) return true
                val page = doc.page(op.optString("p")) ?: return false
                ids(op).all { id -> page.items.firstOrNull { it.id == id }?.by == identity }
            }
            else -> false
        }
    }

    /** Inverse ops for undo (web inverseOf). [before] = the page before [op]. */
    fun inverse(op: JSONObject, before: Page?, doc: Doc): List<JSONObject> = when (op.optString("k")) {
        "add" -> listOf(del(op.optString("p"), listOf(op.optJSONObject("item")?.optString("id") ?: "")))
        "del", "clear", "xf" -> {
            // Undo puts the items back as they were (an add with an existing id replaces it).
            if (before == null) emptyList()
            else {
                val set = if (op.optString("k") == "clear") null else ids(op).toHashSet()
                before.items.filter { set == null || it.id in set }.map { add(before.id, it) }
            }
        }
        "bg" -> if (before != null) listOf(bg(op.optString("p"), before.bg)) else emptyList()
        "newpage" -> listOf(delPage(op.optString("id")))
        "go" -> listOf(go(doc.cur))
        else -> emptyList()
    }
}

/** A move / resize (web `xf` op fields). */
data class WbXf(val s: Double, val ox: Double, val oy: Double, val dx: Double, val dy: Double)

/** Hit testing for the erasers (web hitItem / itemBounds / itemsInRect). */
object WbGeom {
    /** JS Math.round. */
    private fun jr(v: Double): Int = Math.floor(v + 0.5).toInt()

    /** Move / scale one item (new object): web transformItem. */
    fun transform(it: Item, t: WbXf): Item {
        fun X(x: Int) = Wb.clampN(jr((x - t.ox) * t.s + t.ox + t.dx), -Wb.PAGE_W, Wb.PAGE_W * 2)
        fun Y(y: Int) = Wb.clampN(jr((y - t.oy) * t.s + t.oy + t.dy), -Wb.PAGE_H, Wb.PAGE_H * 2)
        return when (it) {
            is Item.Stroke -> {
                val pts = IntArrayList(max(16, it.pts.size))
                for (i in 0 until it.pts.size) pts.add(if (i % 2 == 1) Y(it.pts[i]) else X(it.pts[i]))
                Item.Stroke(it.id, it.by, it.tool, it.c, Wb.clampN(it.w * t.s, 1, 80), pts, it.pr?.copy())
            }
            is Item.Text -> Item.Text(it.id, it.by, it.c, Wb.clampN(it.size * t.s, 8, 400), X(it.x), Y(it.y), it.text)
            is Item.Image -> Item.Image(it.id, it.by, X(it.x), Y(it.y), Wb.clampN(it.w * t.s, 1, Wb.PAGE_W * 3), Wb.clampN(it.h * t.s, 1, Wb.PAGE_H * 3), it.src)
            is Item.Shape -> Item.Shape(it.k, it.id, it.by, it.c, Wb.clampN(it.w * t.s, 1, 80), X(it.x1), Y(it.y1), X(it.x2), Y(it.y2), it.fl)
        }
    }

    /** Triangle corners in its box: apex top centre, base along the bottom (web triPoints). */
    fun triPoints(x1: Int, y1: Int, x2: Int, y2: Int): List<Pair<Double, Double>> {
        val l = min(x1, x2).toDouble(); val r = max(x1, x2).toDouble(); val t = min(y1, y2).toDouble(); val b = max(y1, y2).toDouble()
        return listOf((l + r) / 2 to t, r to b, l to b)
    }

    /** Union of item bounds, or null. */
    fun union(items: List<Item>): Box? {
        if (items.isEmpty()) return null
        var x0 = Double.POSITIVE_INFINITY; var y0 = Double.POSITIVE_INFINITY
        var x1 = Double.NEGATIVE_INFINITY; var y1 = Double.NEGATIVE_INFINITY
        for (it in items) {
            val b = bounds(it)
            x0 = min(x0, b.x); y0 = min(y0, b.y); x1 = max(x1, b.x + b.w); y1 = max(y1, b.y + b.h)
        }
        return Box(x0, y0, x1 - x0, y1 - y0)
    }

    data class Box(val x: Double, val y: Double, val w: Double, val h: Double)

    fun segDist(px: Double, py: Double, x1: Double, y1: Double, x2: Double, y2: Double): Double {
        val dx = x2 - x1
        val dy = y2 - y1
        val len = dx * dx + dy * dy
        val t = if (len != 0.0) max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / len)) else 0.0
        return hypot(px - (x1 + t * dx), py - (y1 + t * dy))
    }

    fun bounds(it: Item): Box = when (it) {
        is Item.Stroke -> {
            var x0 = Double.POSITIVE_INFINITY; var y0 = Double.POSITIVE_INFINITY
            var x1 = Double.NEGATIVE_INFINITY; var y1 = Double.NEGATIVE_INFINITY
            var i = 0
            while (i + 1 < it.pts.size) {
                x0 = min(x0, it.pts[i].toDouble()); x1 = max(x1, it.pts[i].toDouble())
                y0 = min(y0, it.pts[i + 1].toDouble()); y1 = max(y1, it.pts[i + 1].toDouble())
                i += 2
            }
            val pad = it.w / 2.0
            Box(x0 - pad, y0 - pad, x1 - x0 + it.w, y1 - y0 + it.w)
        }
        is Item.Text -> {
            val lines = it.text.split('\n')
            Box(it.x.toDouble(), it.y.toDouble(), lines.maxOf { l -> l.length } * it.size * 0.55, lines.size * it.size * 1.25)
        }
        is Item.Image -> Box(it.x.toDouble(), it.y.toDouble(), it.w.toDouble(), it.h.toDouble())
        is Item.Shape -> Box(
            min(it.x1, it.x2) - it.w.toDouble(), min(it.y1, it.y2) - it.w.toDouble(),
            abs(it.x2 - it.x1) + 2.0 * it.w, abs(it.y2 - it.y1) + 2.0 * it.w,
        )
    }

    fun hit(it: Item, x: Double, y: Double, r: Double): Boolean = when (it) {
        is Item.Stroke -> {
            val tol = r + it.w / 2.0
            if (it.pts.size == 2) hypot(x - it.pts[0], y - it.pts[1]) <= tol
            else {
                var hitAny = false
                var i = 0
                while (i + 3 < it.pts.size) {
                    if (segDist(x, y, it.pts[i].toDouble(), it.pts[i + 1].toDouble(), it.pts[i + 2].toDouble(), it.pts[i + 3].toDouble()) <= tol) { hitAny = true; break }
                    i += 2
                }
                hitAny
            }
        }
        is Item.Shape -> when (it.k) {
            "line", "arrow" -> segDist(x, y, it.x1.toDouble(), it.y1.toDouble(), it.x2.toDouble(), it.y2.toDouble()) <= r + it.w / 2.0
            "tri" -> {
                val tol = r + it.w / 2.0
                val (a, b, c) = triPoints(it.x1, it.y1, it.x2, it.y2)
                segDist(x, y, a.first, a.second, b.first, b.second) <= tol || segDist(x, y, b.first, b.second, c.first, c.second) <= tol ||
                    segDist(x, y, c.first, c.second, a.first, a.second) <= tol
            }
            "rect" -> {
                val tol = r + it.w / 2.0
                val a = it.x1.toDouble(); val b = it.y1.toDouble(); val c = it.x2.toDouble(); val d = it.y2.toDouble()
                segDist(x, y, a, b, c, b) <= tol || segDist(x, y, c, b, c, d) <= tol || segDist(x, y, c, d, a, d) <= tol || segDist(x, y, a, d, a, b) <= tol
            }
            else -> {
                val cx = (it.x1 + it.x2) / 2.0; val cy = (it.y1 + it.y2) / 2.0
                val rx = (abs(it.x2 - it.x1) / 2.0).takeIf { v -> v != 0.0 } ?: 1.0
                val ry = (abs(it.y2 - it.y1) / 2.0).takeIf { v -> v != 0.0 } ?: 1.0
                val dd = hypot((x - cx) / rx, (y - cy) / ry)
                abs(dd - 1) * min(rx, ry) <= r + it.w / 2.0
            }
        }
        else -> {
            val b = bounds(it)
            x >= b.x - r && x <= b.x + b.w + r && y >= b.y - r && y <= b.y + b.h + r
        }
    }

    fun inRect(page: Page, x1: Double, y1: Double, x2: Double, y2: Double, filter: (Item) -> Boolean): List<String> {
        val rx = min(x1, x2); val ry = min(y1, y2); val rw = abs(x2 - x1); val rh = abs(y2 - y1)
        return page.items.filter(filter).filter {
            val b = bounds(it)
            b.x < rx + rw && b.x + b.w > rx && b.y < ry + rh && b.y + b.h > ry
        }.map { it.id }
    }
}

/** Pen batching (web PointBatcher): one `pts` op per flush; pressure when the stroke has it. */
class PointBatcher(val page: String, val id: String, val withPressure: Boolean = false) {
    private var pending = IntArrayList()
    private var pressure = IntArrayList()
    private var lastX = Int.MIN_VALUE
    private var lastY = Int.MIN_VALUE
    /** [p] = pressure 0–1 (stylus); ignored unless the stroke has pressure. */
    fun push(x: Double, y: Double, p: Float = 0.5f) {
        val rx = Math.floor(x + 0.5).toInt(); val ry = Math.floor(y + 0.5).toInt()
        // Identical to the last point (also across flushes): nothing to add.
        if (rx == lastX && ry == lastY) return
        lastX = rx; lastY = ry
        pending.add(rx); pending.add(ry)
        if (withPressure) pressure.add(Wb.pressurePct(p))
    }
    /** Points not yet flushed (drawn at once, before the next batch leaves). */
    fun peek(): IntArrayList = pending
    fun peekPressure(): IntArrayList = pressure
    fun flush(): JSONObject? {
        if (pending.size == 0) return null
        val pts = pending.toArray()
        val pr = if (withPressure) pressure.toArray() else null
        pending = IntArrayList()
        pressure = IntArrayList()
        return WbOps.pts(page, id, pts, pr)
    }
}

/** Fading laser trail (web LaserTrail). */
class LaserTrail {
    class Pt(val x: Int, val y: Int, val t: Long)
    val pts = ArrayList<Pt>()
    fun add(flat: IntArray, now: Long = System.currentTimeMillis()) {
        var i = 0
        while (i + 1 < flat.size) {
            pts.add(Pt(flat[i].coerceIn(0, Wb.PAGE_W), flat[i + 1].coerceIn(0, Wb.PAGE_H), now))
            i += 2
        }
        if (pts.size > 400) pts.subList(0, pts.size - 400).clear()
    }
    /** Drop faded points; true while anything is left to draw. */
    fun prune(now: Long = System.currentTimeMillis()): Boolean {
        var n = 0
        while (n < pts.size && now - pts[n].t > Wb.LASER_MS) n++
        if (n > 0) pts.subList(0, n).clear()
        return pts.isNotEmpty()
    }
}

/** Packet encoding, chunking and snapshot compression (web encodePacket / chunkPackets / codec.ts). */
object WbCodec {
    fun opsPacket(ops: List<JSONObject>): JSONObject = JSONObject().put("v", 1).put("t", "ops").put("ops", JSONArray(ops))

    /** Laser points (page units), one small lossy packet (web laserPacket). */
    fun laserPacket(pts: IntArray): ByteArray =
        JSONObject().put("v", 1).put("t", "laser").put("pts", JSONArray().also { a -> pts.forEach { a.put(it) } }).toString().toByteArray(Charsets.UTF_8)

    /** Packet JSON → wire byte arrays (chunked above CHUNK_CHARS like the web). */
    fun encode(packet: JSONObject): List<ByteArray> {
        val payload = packet.toString()
        if (payload.length <= Wb.CHUNK_CHARS) return listOf(payload.toByteArray(Charsets.UTF_8))
        val n = (payload.length + Wb.CHUNK_CHARS - 1) / Wb.CHUNK_CHARS
        val id = Wb.newId("c")
        return (0 until n).map { i ->
            JSONObject().put("v", 1).put("t", "chunk").put("id", id).put("i", i).put("n", n)
                .put("d", payload.substring(i * Wb.CHUNK_CHARS, min(payload.length, (i + 1) * Wb.CHUNK_CHARS)))
                .toString().toByteArray(Charsets.UTF_8)
        }
    }

    fun decode(bytes: ByteArray): JSONObject? = try {
        val p = JSONObject(String(bytes, Charsets.UTF_8))
        if (p.optInt("v") == 1 && p.opt("t") is String) p else null
    } catch (_: Exception) {
        null
    }

    /** deflate-raw + base64 (z: 1), as the web CompressionStream('deflate-raw'). */
    fun snapshot(doc: Doc): JSONObject {
        val json = doc.toJson().toString().toByteArray(Charsets.UTF_8)
        val d = Deflater(6, true)
        d.setInput(json)
        d.finish()
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (!d.finished()) out.write(buf, 0, d.deflate(buf))
        d.end()
        return JSONObject().put("v", 1).put("t", "snap").put("doc", Base64.getEncoder().encodeToString(out.toByteArray())).put("z", 1)
    }

    fun readSnapshot(p: JSONObject): Doc? = try {
        if (p.optInt("z") == 0) Doc.clean(JSONObject(p.optString("doc")))
        else {
            val raw = Base64.getDecoder().decode(p.optString("doc"))
            val inf = Inflater(true)
            inf.setInput(raw)
            val out = ByteArrayOutputStream()
            val buf = ByteArray(16 * 1024)
            while (!inf.finished()) {
                val n = inf.inflate(buf)
                if (n == 0 && (inf.needsInput() || inf.needsDictionary())) break
                out.write(buf, 0, n)
                if (out.size() > 40_000_000) break
            }
            inf.end()
            Doc.clean(JSONObject(String(out.toByteArray(), Charsets.UTF_8)))
        }
    } catch (_: Exception) {
        null
    }

    fun toB64(packets: List<ByteArray>): List<String> = packets.map { Base64.getEncoder().encodeToString(it) }
}

/** Reassembles chunk packets (web ChunkAssembler). */
class ChunkAssembler {
    private class Entry(val n: Int, val got: Array<String?>, var count: Int, val at: Long)
    private val parts = HashMap<String, Entry>()

    fun add(p: JSONObject, now: Long = System.currentTimeMillis()): JSONObject? {
        parts.entries.removeAll { now - it.value.at > 60_000 }
        val n = p.optInt("n", -1); val i = p.optInt("i", -1)
        if (!(n in 1..2000 && i in 0 until n)) return null
        val id = p.optString("id")
        val e = parts.getOrPut(id) { Entry(n, arrayOfNulls(n), 0, now) }
        if (i >= e.n) return null
        if (e.got[i] == null) {
            e.got[i] = p.optString("d")
            e.count++
        }
        if (e.count < e.n) return null
        parts.remove(id)
        return try { JSONObject(e.got.joinToString("") { it ?: "" }) } catch (_: Exception) { null }
    }
}
