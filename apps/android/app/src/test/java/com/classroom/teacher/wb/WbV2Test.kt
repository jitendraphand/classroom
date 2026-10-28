package com.classroom.teacher.wb

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/** Whiteboard v2 (pressure, xf, triangle, fills, backgrounds, laser, snapping): same cases as the web tests/whiteboardV2.test.ts. */
class WbV2Test {
    private fun stroke(pts: List<Int>, pr: List<Int>? = null) = JSONObject().put("k", "stroke").put("id", "a1").put("by", "t").put("tool", "pen")
        .put("c", "#111111").put("w", 4).put("pts", JSONArray(pts)).also { if (pr != null) it.put("pr", JSONArray(pr)) }

    @Test
    fun pressureKeptForPenStrokesWithOneValuePerPoint() {
        val ok = Item.clean(stroke(listOf(0, 0, 10, 10), listOf(20, 140))) as Item.Stroke
        assertEquals(listOf(20, 100), ok.pr!!.toArray().toList())
        assertNull((Item.clean(stroke(listOf(0, 0, 10, 10), listOf(20))) as Item.Stroke).pr)
        assertNull((Item.clean(stroke(listOf(0, 0, 10, 10), listOf(20, 30)).put("tool", "hl")) as Item.Stroke).pr)
        assertEquals(42, Wb.pressurePct(0.42f))
        assertEquals(50, Wb.pressurePct(Float.NaN))
    }

    @Test
    fun appendedPointsKeepPressureAligned() {
        val doc = Doc.empty()
        val p = doc.pages[0].id
        WbOps.apply(doc, WbOps.add(p, Item.clean(stroke(listOf(0, 0), listOf(30)))!!))
        WbOps.apply(doc, WbOps.pts(p, "a1", intArrayOf(5, 5, 6, 6), intArrayOf(60, 70)))
        WbOps.apply(doc, WbOps.pts(p, "a1", intArrayOf(7, 7)))
        val s = doc.pages[0].items[0] as Item.Stroke
        assertEquals(s.pts.size / 2, s.pr!!.size)
        assertEquals(listOf(30, 60, 70, 70), s.pr.toArray().toList())
    }

    @Test
    fun batcherSendsPressureOnlyForPressureStrokesAndDropsDuplicates() {
        val b = PointBatcher("p", "s1", withPressure = true)
        b.push(1.0, 1.0, 0.5f)
        b.push(1.0, 1.0, 0.9f)
        b.push(2.0, 2.0, 0.25f)
        assertEquals(listOf(1, 1, 2, 2), b.peek().toArray().toList())
        val op = b.flush()!!
        assertEquals("[1,1,2,2]", op.getJSONArray("pts").toString())
        assertEquals("[50,25]", op.getJSONArray("pr").toString())
        b.push(2.0, 2.0, 1f)
        assertNull(b.flush())
        val plain = PointBatcher("p", "s2")
        plain.push(3.0, 3.0, 0.7f)
        assertFalse(plain.flush()!!.has("pr"))
    }

    @Test
    fun xfMovesAndResizesAndUndoRestores() {
        val doc = Doc.empty()
        val p = doc.pages[0].id
        WbOps.apply(doc, WbOps.add(p, Item.Shape("rect", "r1", "t", "#111111", 4, 100, 100, 200, 200)))
        WbOps.apply(doc, WbOps.add(p, Item.Text("t1", "t", "#111111", 40, 10, 10, "Hi")))
        val op = WbOps.xf(p, listOf("r1"), 2.0, 100, 100, 50, 0)
        val before = doc.pages[0].deepCopy()
        val undo = WbOps.inverse(op, before, doc)
        assertTrue(WbOps.apply(doc, op))
        val r = doc.pages[0].items[0] as Item.Shape
        assertEquals(listOf(150, 350, 300, 8), listOf(r.x1, r.x2, r.y2, r.w))
        assertEquals(10, (doc.pages[0].items[1] as Item.Text).x)
        undo.forEach { WbOps.apply(doc, it) }
        assertEquals(before.toJson().toString(), doc.pages[0].toJson().toString())
        assertFalse(WbOps.apply(doc, WbOps.xf(p, listOf("nope"), 1.0, 0, 0, 5, 5)))
    }

    @Test
    fun xfScalesStrokesAndText() {
        val t = WbXf(0.5, 0.0, 0.0, 10.0, 20.0)
        val s = WbGeom.transform(Item.clean(stroke(listOf(100, 100, 200, 300), listOf(10, 90)))!!, t) as Item.Stroke
        assertEquals(listOf(60, 70, 110, 170), s.pts.toArray().toList())
        assertEquals(2, s.w)
        assertEquals(listOf(10, 90), s.pr!!.toArray().toList())
        val txt = WbGeom.transform(Item.Text("x", "t", "#111111", 40, 100, 100, "a"), t) as Item.Text
        assertEquals(listOf(20, 60), listOf(txt.size, txt.x))
    }

    @Test
    fun triangleAndFillValidatedAndHitOnEdges() {
        val tri = Item.clean(JSONObject("""{"k":"tri","id":"g1","by":"t","c":"#e53935","w":4,"x1":0,"y1":0,"x2":200,"y2":100,"fl":1}""")) as Item.Shape
        assertEquals("tri", tri.k)
        assertTrue(tri.fl)
        assertFalse((Item.clean(JSONObject("""{"k":"line","id":"g2","by":"t","c":"#111111","w":4,"x1":0,"y1":0,"x2":1,"y2":1,"fl":1}""")) as Item.Shape).fl)
        assertTrue(WbGeom.hit(tri, 100.0, 0.0, 3.0))
        assertTrue(WbGeom.hit(tri, 100.0, 100.0, 3.0))
        assertFalse(WbGeom.hit(tri, 100.0, 60.0, 3.0))
        assertEquals(1, tri.toJson().getInt("fl"))
    }

    @Test
    fun backgroundsDotsAndGraphSurviveSnapshots() {
        assertTrue("dots" in Wb.BACKGROUNDS && "graph" in Wb.BACKGROUNDS)
        val doc = Doc.clean(JSONObject("""{"v":1,"cur":0,"pages":[{"id":"p1","bg":"graph","items":[]},{"id":"p2","bg":"stars","items":[]}]}"""))!!
        assertEquals(listOf("graph", "white"), doc.pages.map { it.bg })
    }

    @Test
    fun laserTrailFades() {
        val trail = LaserTrail()
        trail.add(intArrayOf(10, 10, 20, 20), 1000)
        assertTrue(trail.prune(1000 + Wb.LASER_MS - 1))
        assertFalse(trail.prune(1000 + Wb.LASER_MS + 1))
        val pkt = JSONObject(String(WbCodec.laserPacket(intArrayOf(100, 201)), Charsets.UTF_8))
        assertEquals("laser", pkt.getString("t"))
        assertEquals("[100,201]", pkt.getJSONArray("pts").toString())
    }

    private fun circle(cx: Int, cy: Int, rr: Int, n: Int = 60, wobble: Int = 0): IntArray {
        val out = ArrayList<Int>()
        for (i in 0..n) {
            val a = i.toDouble() / n * PI * 2
            val r = rr + (if (i % 2 == 1) wobble else -wobble)
            out.add(Math.floor(cx + r * cos(a) + 0.5).toInt()); out.add(Math.floor(cy + r * sin(a) + 0.5).toInt())
        }
        return out.toIntArray()
    }

    private fun polyline(pts: List<Pair<Int, Int>>, per: Int = 15): IntArray {
        val out = ArrayList<Int>()
        for (i in 0 until pts.size - 1) {
            val (a, b) = pts[i] to pts[i + 1]
            for (j in 0 until per) {
                out.add(Math.floor(a.first + (b.first - a.first) * j / per.toDouble() + 0.5).toInt())
                out.add(Math.floor(a.second + (b.second - a.second) * j / per.toDouble() + 0.5).toInt())
            }
        }
        out.add(pts.last().first); out.add(pts.last().second)
        return out.toIntArray()
    }

    @Test
    fun shakyLineSnapsFlat() {
        val pts = ArrayList<Int>()
        var x = 100
        while (x <= 600) {
            pts.add(x); pts.add(300 + (if (x % 20 != 0) 3 else -3) + ((x - 100) * 0.04).roundToInt())
            x += 10
        }
        val s = WbRecognize.recognize(pts.toIntArray())!!
        assertEquals("line", s.k)
        assertEquals(s.y1, s.y2)
    }

    @Test
    fun roughCircleEllipseBoxTriangle() {
        val c = WbRecognize.recognize(circle(500, 400, 150, 60, 4))!!
        assertEquals("ellipse", c.k)
        assertEquals(c.x2 - c.x1, c.y2 - c.y1)
        val wide = ArrayList<Int>()
        for (i in 0..60) {
            val a = i / 60.0 * PI * 2
            wide.add(Math.floor(500 + 300 * cos(a) + 0.5).toInt()); wide.add(Math.floor(400 + 120 * sin(a) + 0.5).toInt())
        }
        val e = WbRecognize.recognize(wide.toIntArray())!!
        assertEquals("ellipse", e.k)
        assertTrue(e.x2 - e.x1 > 2 * (e.y2 - e.y1))
        assertEquals("rect", WbRecognize.recognize(polyline(listOf(100 to 100, 500 to 102, 498 to 400, 102 to 398, 100 to 104)))?.k)
        assertEquals("tri", WbRecognize.recognize(polyline(listOf(300 to 100, 500 to 400, 100 to 400, 298 to 106)))?.k)
    }

    @Test
    fun scribblesAndOpenCurvesStayFreeHand() {
        assertNull(WbRecognize.recognize(intArrayOf(0, 0, 5, 5, 10, 0, 15, 5)))
        assertNull(WbRecognize.recognize(polyline(listOf(100 to 100, 200 to 300, 300 to 100, 400 to 300, 500 to 100))))
        val arc = ArrayList<Int>()
        for (i in 0..30) {
            val a = i / 30.0 * PI
            arc.add(Math.floor(400 + 200 * cos(a) + 0.5).toInt()); arc.add(Math.floor(400 - 200 * sin(a) + 0.5).toInt())
        }
        assertNull(WbRecognize.recognize(arc.toIntArray()))
        assertNotNull(WbRecognize.resample(listOf(WbRecognize.P(0.0, 0.0), WbRecognize.P(100.0, 0.0)), 5).let { r -> r.map { it.x.roundToInt() }.also { assertEquals(listOf(0, 25, 50, 75, 100), it) } })
    }
}
