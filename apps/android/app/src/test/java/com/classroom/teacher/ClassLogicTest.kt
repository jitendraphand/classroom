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
}
