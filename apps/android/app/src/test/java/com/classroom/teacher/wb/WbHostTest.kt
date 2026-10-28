package com.classroom.teacher.wb

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WbHostTest {
    private val sent = ArrayList<Pair<List<ByteArray>, List<String>?>>()
    private val host = WbHost(Doc.empty()) { p, to -> sent.add(p to to) }
    private val pg get() = host.doc.currentPage()

    private fun stroke(by: String) = Item.Stroke(Wb.newId("s"), by, "pen", "#111111", 4, IntArrayList().also { it.add(10); it.add(10) })
    private fun opsBytes(ops: List<JSONObject>, by: String? = null) =
        WbCodec.opsPacket(ops).also { if (by != null) it.put("by", by) }.toString().toByteArray()

    @Test fun localEditPublishesAndUndoes() {
        host.local(listOf(WbOps.add(pg.id, stroke("teacher"))))
        assertEquals(1, pg.items.size)
        assertEquals(1, sent.size)
        host.undo()
        assertEquals(0, pg.items.size)
        host.redo()
        assertEquals(1, pg.items.size)
    }

    @Test fun packetsFromStudentIdentitiesAreIgnored() {
        // Students hold no LiveKit data grant; the server relays their ops (sender null, `by` set).
        val b = opsBytes(listOf(WbOps.add(pg.id, stroke("student_a"))), by = "student_a")
        assertFalse(host.receive(b, "student_a", setOf("student_a")))
        assertTrue(host.receive(b, null, emptySet()))
    }

    @Test fun relayedStudentCannotDrawAsSomeoneElseOrDelete() {
        host.local(listOf(WbOps.add(pg.id, stroke("teacher"))))
        val forged = opsBytes(listOf(WbOps.add(pg.id, stroke("student_b"))), by = "student_a")
        assertFalse(host.receive(forged, null, emptySet()))
        val del = opsBytes(listOf(WbOps.clear(pg.id)), by = "student_a")
        assertFalse(host.receive(del, null, emptySet()))
        assertEquals(1, pg.items.size)
    }

    @Test fun teachersAndOddPacketsIgnored() {
        val b = opsBytes(listOf(WbOps.add(pg.id, stroke("teacher_x"))))
        assertFalse(host.receive(b, "teacher_x", setOf("teacher_x")))
        val snap = WbCodec.snapshot(Doc.empty()).toString().toByteArray()
        assertFalse(host.receive(snap, "student_a", setOf("student_a")))
    }

    @Test fun serverRelayUsesBy() {
        val b = opsBytes(listOf(WbOps.add(pg.id, stroke("student_c"))), by = "student_c")
        assertTrue(host.receive(b, null, emptySet()))
    }

    @Test fun reqSendsSnapshotToRequester() {
        val req = JSONObject().put("v", 1).put("t", "req").put("to", "student_a").toString().toByteArray()
        host.receive(req, null, emptySet()) // the server relays a student's request
        assertEquals(listOf("student_a"), sent.last().second)
        assertEquals("snap", WbCodec.decode(sent.last().first[0])!!.optString("t"))
    }

    @Test fun storableLimits() {
        assertTrue(WbHost.storable(host.snapshotPackets()) != null)
        assertEquals(null, WbHost.storable(List(65) { ByteArray(1) }))
    }
}
