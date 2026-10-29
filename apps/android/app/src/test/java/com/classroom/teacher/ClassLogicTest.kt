package com.classroom.teacher

import org.junit.Assert.assertEquals
import org.junit.Test

class ClassLogicTest {
    @Test
    fun tiles_pinnedFirstThenSpeakerThenStickyThenRotation() {
        val tiles = ClassLogic.pickTiles(
            pool = listOf("a", "b", "c", "d", "e"),
            teacherPins = listOf("d", "x"),
            speakingId = "b",
            sticky = listOf("e"),
            rotation = listOf("c", "a"),
            slots = 3,
        )
        assertEquals(listOf("d", "b", "e"), tiles)
    }

    @Test
    fun tiles_onlyPublishingStudents_andCapRespected() {
        assertEquals(listOf("a"), ClassLogic.pickTiles(listOf("a"), emptyList(), null, emptyList(), emptyList(), 3))
        assertEquals(
            listOf("p1", "p2", "p3"),
            ClassLogic.pickTiles(listOf("p1", "p2", "p3", "p4"), listOf("p1", "p2", "p3", "p4"), "p4", emptyList(), emptyList(), 3),
        )
    }

    @Test
    fun tiles_rotationFillsRemainingSlots() {
        val pool = listOf("a", "b", "c", "d")
        val r1 = ClassLogic.pickTiles(pool, listOf("d"), null, emptyList(), listOf("a", "b", "c"), 3)
        assertEquals(listOf("d", "a", "b"), r1)
        val r2 = ClassLogic.pickTiles(pool, listOf("d"), null, emptyList(), ClassLogic.rotate(listOf("a", "b", "c")), 3)
        assertEquals(listOf("d", "b", "c"), r2)
    }

    @Test
    fun pinOrder_oldestFirst() {
        val s = listOf(
            StudentInfo("1", "a", "A", pinned = true, pinnedAt = 30),
            StudentInfo("2", "b", "B"),
            StudentInfo("3", "c", "C", pinned = true, pinnedAt = 10),
        )
        assertEquals(listOf("c", "a"), ClassLogic.pinOrder(s))
    }

    @Test
    fun roster_handsFirstByRaiseTime_thenNames() {
        val sorted = ClassLogic.sortRoster(
            listOf(
                StudentInfo("1", "i1", "Zed"),
                StudentInfo("2", "i2", "Amy", handRaised = true, handRaisedAt = 300),
                StudentInfo("3", "i3", "Bob", handRaised = true, handRaisedAt = 100),
                StudentInfo("4", "i4", "Cat", handRaised = true),
                StudentInfo("5", "i5", "abe"),
            ),
        )
        assertEquals(listOf("Bob", "Amy", "Cat", "abe", "Zed"), sorted.map { it.name })
    }

    @Test
    fun windowClassBreakpoints() {
        assertEquals(0, ClassLogic.windowClass(360))
        assertEquals(0, ClassLogic.windowClass(599))
        assertEquals(1, ClassLogic.windowClass(600))
        assertEquals(1, ClassLogic.windowClass(839))
        assertEquals(2, ClassLogic.windowClass(840))
    }

    @Test
    fun rosterWindowShowsAPageAtATime() {
        val rows = (1..400).toList()
        val (shown, hidden, next) = ClassLogic.rosterWindow(rows, ClassLogic.ROSTER_PAGE)
        assertEquals(150, shown.size)
        assertEquals(250, hidden)
        assertEquals(150, next)
        val (all, none, _) = ClassLogic.rosterWindow(rows, 450)
        assertEquals(400, all.size)
        assertEquals(0, none)
        assertEquals(Triple(listOf(1, 2), 0, 0), ClassLogic.rosterWindow(listOf(1, 2), 0))
        assertEquals(100, ClassLogic.rosterWindow(rows, 300).third)
    }

    @Test
    fun updateNoticeFollowsTheServerVersions() {
        val url = "https://example.com/apk"
        assertEquals(null, ClassLogic.updateNotice("1.2.0-20261028", null, null, url))
        assertEquals(null, ClassLogic.updateNotice("1.2.0-20261028", "1.2.0", "1.1.0", url))
        assertEquals(ClassLogic.UpdateNotice(false, "1.3.0", url), ClassLogic.updateNotice("1.2.0-20261028", "1.3.0", "1.1.0", url))
        assertEquals(ClassLogic.UpdateNotice(true, "1.3.0", null), ClassLogic.updateNotice("1.2.0", "1.3.0", "1.2.5", null))
        assertEquals(ClassLogic.UpdateNotice(true, "1.2.5", url), ClassLogic.updateNotice("1.2.0", null, "1.2.5", url))
        assertEquals(null, ClassLogic.updateNotice("dev-build", "9.9.9", "9.9.9", url))
        assertEquals(true, ClassLogic.versionLess(listOf(1, 9, 9), listOf(1, 10, 0)))
    }
}
