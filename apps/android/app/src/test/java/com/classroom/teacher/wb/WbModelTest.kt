package com.classroom.teacher.wb

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WbModelTest {
    private fun stroke(id: String, by: String, vararg pts: Int) =
        JSONObject().put("k", "stroke").put("id", id).put("by", by).put("tool", "pen").put("c", "#e53935").put("w", 4).put("pts", JSONArray(pts.toList()))

    @Test fun cleanItemValidates() {
        assertNull(Item.clean(JSONObject().put("k", "stroke").put("id", "bad id!").put("pts", JSONArray())))
        val s = Item.clean(stroke("t1", "me", 1, 2, 3, 4).put("c", "red").put("w", 500)) as Item.Stroke
        assertEquals("#111111", s.c)
        assertEquals(80, s.w)
        assertNull(Item.clean(JSONObject().put("k", "text").put("id", "x1").put("text", "")))
        assertNull(Item.clean(JSONObject().put("k", "img").put("id", "x1").put("src", "http://evil")))
        val sh = Item.clean(JSONObject().put("k", "rect").put("id", "r1").put("x1", 99999).put("y1", 2.5).put("x2", 3).put("y2", -9999)) as Item.Shape
        assertEquals(3840, sh.x1); assertEquals(3, sh.y1); assertEquals(-1080, sh.y2)
    }

    @Test fun applyOpsLikeWeb() {
        val doc = Doc.empty()
        val p = doc.pages[0].id
        assertTrue(WbOps.apply(doc, JSONObject().put("k", "add").put("p", p).put("item", stroke("t1", "teacher", 1, 1))))
        assertTrue(WbOps.apply(doc, WbOps.pts(p, "t1", intArrayOf(5, 6, 7, 8))))
        assertEquals(6, (doc.pages[0].items[0] as Item.Stroke).pts.size)
        assertTrue(WbOps.apply(doc, WbOps.newPage(1, "p2", "grid")))
        assertEquals(1, doc.cur)
        assertFalse(WbOps.apply(doc, WbOps.newPage(1, "p2", "grid")))
        assertTrue(WbOps.apply(doc, WbOps.go(0)))
        assertTrue(WbOps.apply(doc, JSONObject().put("k", "delBy").put("by", "teacher")))
        assertTrue(doc.pages[0].items.isEmpty())
        assertTrue(WbOps.apply(doc, WbOps.delPage("p2")))
        assertFalse(WbOps.apply(doc, WbOps.delPage(p)))
        assertFalse(WbOps.apply(doc, WbOps.bg(p, "pink")))
    }

    @Test fun studentRules() {
        val doc = Doc.empty()
        val p = doc.pages[0].id
        val mine = JSONObject().put("k", "add").put("p", p).put("item", stroke("s1", "student_a", 1, 1))
        assertTrue(WbOps.studentAllowed(mine, "student_a", doc))
        assertFalse(WbOps.studentAllowed(mine, "student_b", doc))
        WbOps.apply(doc, mine)
        assertTrue(WbOps.studentAllowed(WbOps.pts(p, "s1", intArrayOf(1, 2)), "student_a", doc))
        assertFalse(WbOps.studentAllowed(WbOps.del(p, listOf("s1")), "student_b", doc))
        assertFalse(WbOps.studentAllowed(WbOps.clear(p), "student_a", doc))
        val text = JSONObject().put("k", "add").put("p", p).put("item", JSONObject().put("k", "text").put("id", "s2").put("by", "student_a").put("text", "hi"))
        assertFalse(WbOps.studentAllowed(text, "student_a", doc))
    }

    @Test fun undoInverse() {
        val doc = Doc.empty()
        val p = doc.pages[0].id
        WbOps.apply(doc, JSONObject().put("k", "add").put("p", p).put("item", stroke("t1", "me", 1, 1)))
        val before = doc.pages[0].deepCopy()
        val clear = WbOps.clear(p)
        WbOps.apply(doc, clear)
        WbOps.inverse(clear, before, doc).forEach { WbOps.apply(doc, it) }
        assertEquals(1, doc.pages[0].items.size)
    }

    @Test fun snapshotRoundTripAndChunks() {
        val doc = Doc.empty("lined")
        val p = doc.pages[0].id
        for (i in 0 until 300) WbOps.apply(doc, JSONObject().put("k", "add").put("p", p).put("item", stroke("t$i", "me", *IntArray(200) { kotlin.random.Random(i * 1000 + it).nextInt(1900) })))
        val snap = WbCodec.snapshot(doc)
        val back = WbCodec.readSnapshot(snap)!!
        assertEquals(doc.toJson().toString(), back.toJson().toString())
        val wire = WbCodec.encode(snap)
        assertTrue(wire.size > 1)
        val asm = ChunkAssembler()
        var whole: JSONObject? = null
        for (b in wire.reversed()) whole = asm.add(WbCodec.decode(b)!!) ?: whole
        assertNotNull(whole)
        assertEquals("snap", whole!!.getString("t"))
    }

    /** Bytes produced by the browser's CompressionStream('deflate-raw') of {"v":1,"pages":[{"id":"p1","bg":"grid","items":[]}],"cur":0}. */
    @Test fun readsRawDeflateFromWeb() {
        val json = "{\"v\":1,\"pages\":[{\"id\":\"p1\",\"bg\":\"grid\",\"items\":[]}],\"cur\":0}"
        val d = java.util.zip.Deflater(9, true); d.setInput(json.toByteArray()); d.finish()
        val buf = ByteArray(512); val n = d.deflate(buf)
        val b64 = java.util.Base64.getEncoder().encodeToString(buf.copyOf(n))
        val doc = WbCodec.readSnapshot(JSONObject().put("v", 1).put("t", "snap").put("doc", b64).put("z", 1))!!
        assertEquals("grid", doc.pages[0].bg)
        val plain = WbCodec.readSnapshot(JSONObject().put("v", 1).put("t", "snap").put("doc", json).put("z", 0))!!
        assertEquals("p1", plain.pages[0].id)
    }

    @Test fun hitTesting() {
        val s = Item.clean(stroke("t1", "me", 0, 0, 100, 0))!!
        assertTrue(WbGeom.hit(s, 50.0, 3.0, 2.0))
        assertFalse(WbGeom.hit(s, 50.0, 30.0, 2.0))
        val page = Page("p1", "white", mutableListOf(s))
        assertEquals(listOf("t1"), WbGeom.inRect(page, 40.0, -5.0, 60.0, 5.0) { true })
        val b = PointBatcher("p1", "t1"); b.push(1.4, 2.6); b.push(1.2, 2.7); b.push(5.0, 5.0)
        assertEquals(4, b.flush()!!.getJSONArray("pts").length())
        assertNull(b.flush())
    }
}
