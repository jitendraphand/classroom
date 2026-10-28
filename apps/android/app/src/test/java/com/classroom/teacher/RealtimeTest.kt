package com.classroom.teacher

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RealtimeTest {
    @Test fun senderKinds() {
        assertEquals(Realtime.Sender.SERVER, Realtime.senderKind(null))
        assertEquals(Realtime.Sender.TEACHER, Realtime.senderKind("teacher_1"))
        assertEquals(Realtime.Sender.OTHER, Realtime.senderKind("teacher_1__screen"))
        assertEquals(Realtime.Sender.STUDENT, Realtime.senderKind("student_9"))
    }

    @Test fun signals() {
        val hand = Realtime.decodeSignal("""{"v":1,"type":"hand","raised":true,"participantId":"p1"}""".toByteArray())
        assertEquals(Realtime.Signal.Hand(true, "p1"), hand)
        assertTrue(Realtime.signalTrusted(hand!!, null))
        assertFalse(Realtime.signalTrusted(hand, "student_x"))
        val allow = Realtime.decodeSignal("""{"v":1,"type":"draw-allow","on":true,"participantId":"p1","identity":"student_a","name":"A","until":1.7E12}""".toByteArray())!!
        assertFalse(Realtime.signalTrusted(allow, "teacher_1"))
        assertTrue(Realtime.signalTrusted(allow, null))
        assertNull(Realtime.decodeSignal("""{"v":1,"type":"hand","raised":"yes","participantId":"p1"}""".toByteArray()))
        assertNull(Realtime.decodeSignal("garbage".toByteArray()))
    }

    @Test fun inkPacketsAndTrust() {
        val p = Realtime.decodeInk(JSONObject("""{"v":1,"t":"pts","id":"abcd","by":"student_a","name":"A","c":"red","from":0,"pts":[0.1,0.2,0.3,0.4]}"""))!!
        // Students hold no data grant: their points arrive as the server's relay (no identity).
        assertTrue(Realtime.inkTrusted(p, null))
        assertFalse(Realtime.inkTrusted(p, "student_a"))
        assertFalse(Realtime.inkTrusted(Realtime.Ink.Clear, "student_a"))
        assertNull(Realtime.decodeInk(JSONObject("""{"v":1,"t":"pts","id":"abcd","by":"s","name":"A","c":"green","pts":[0.1,0.2]}""")))
        assertNull(Realtime.decodeInk(JSONObject("""{"v":1,"t":"pts","id":"abcd","by":"s","name":"A","c":"red","pts":[0.1,5]}""")))
        val list = mutableListOf<Realtime.InkStroke>()
        Realtime.applyInk(list, p)
        Realtime.applyInk(list, Realtime.decodeInk(JSONObject("""{"v":1,"t":"pts","id":"abcd","by":"student_a","name":"A","c":"red","from":2,"pts":[0.5,0.6]}"""))!!)
        assertEquals(4, list[0].pts.size)
        assertEquals(0.5f, list[0].pts[2])
        Realtime.applyInk(list, Realtime.Ink.Del("abcd"))
        assertTrue(list.isEmpty())
        val late = Realtime.parseInkStrokes(JSONArray("""[{"id":"zzzz","by":"student_a","name":"A","color":"blue","pts":[0,0,1,1]}]"""))
        assertEquals("blue", late[0].color)
    }

    @Test fun wording() {
        assertEquals("A and B are drawing", Realtime.drawersLabel(listOf("A", "B")))
        assertEquals("A, B and 3 more are drawing", Realtime.drawersLabel(listOf("A", "B", "C", "D", "E")))
        assertEquals("This class is full. Remove a student or raise the class size limit to admit more.", Realtime.classFullMessage(null))
    }

    @Test fun polling() {
        assertEquals(30_000L, Realtime.pollMs(visible = false, fast = true))
        assertEquals(2_000L, Realtime.pollMs(visible = true, fast = true))
        // Pushes live: a 60 s safety net, as the web teacher (pollPolicy statePollMs).
        assertEquals(60_000L, Realtime.pollMs(visible = true, fast = false))
        assertEquals(60_000L, Realtime.pollMs(visible = false, fast = false))
    }

    @Test fun chatMerge() {
        val merged = Realtime.mergeById(listOf("a" to 1, "b" to 1), listOf("b" to 2, "c" to 1), { it.first })
        assertEquals(listOf("a" to 1, "b" to 2, "c" to 1), merged)
    }

    @Test fun shareLayer() {
        assertEquals(1280 to 720, Realtime.shareLowLayer(1920, 1080))
        assertEquals(576 to 1280, Realtime.shareLowLayer(864, 1920))
        assertNull(Realtime.shareLowLayer(1280, 720))
    }

    @Test fun errorScrubAndRate() {
        val s = ErrorReporter.scrub("GET https://x.io/api/rooms/AB?token=abc failed eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl password=hunter2")
        assertFalse(s.contains("abc"))
        assertFalse(s.contains("hunter2"))
        assertFalse(s.contains("eyJhbGci"))
        var t = 0L
        val r = ErrorReporter { t }
        assertTrue(r.admit("a")); assertFalse(r.admit("a"))
        for (k in listOf("b", "c", "d", "e")) assertTrue(r.admit(k))
        assertFalse(r.admit("f"))
        t = 61_000
        assertTrue(r.admit("g"))
    }
}

class RosterFieldsTest {
    @org.junit.Test
    fun parsesNewStudentFields() {
        val arr = org.json.JSONArray("""[{"id":"a","role":"STUDENT","livekitIdentity":"student_a","displayName":"Asha","drawRequested":true,"drawRequestedAt":5,"drawing":false,"reconnecting":true,"micWaiting":true,"sid":"S12"},{"id":"t","role":"TEACHER"}]""")
        val s = ClassLogic.parseStudents(arr)
        org.junit.Assert.assertEquals(1, s.size)
        org.junit.Assert.assertTrue(s[0].drawRequested && s[0].reconnecting && s[0].micWaiting)
        org.junit.Assert.assertEquals("S12", s[0].sid)
        org.junit.Assert.assertTrue(ClassLogic.matches(s[0], "s1"))
        org.junit.Assert.assertFalse(ClassLogic.matches(s[0], "zz"))
        val q = ClassLogic.parseMicQueue(org.json.JSONArray("""[{"id":"b","name":"B","position":2},{"id":"a","name":"A","position":1}]"""))
        org.junit.Assert.assertEquals(listOf("a", "b"), q.map { it.id })
    }
}
