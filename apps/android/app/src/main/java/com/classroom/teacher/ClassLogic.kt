package com.classroom.teacher

import org.json.JSONArray
import org.json.JSONObject

/** One admitted student from GET /state (teacher view). */
data class StudentInfo(
    val id: String,
    val identity: String,
    val name: String,
    val handRaised: Boolean = false,
    val handRaisedAt: Long? = null,
    val pinned: Boolean = false,
    val pinnedAt: Long? = null,
    val muted: Boolean = false,
    /** "left" / "away" = not in fullscreen (web students). */
    val focus: String? = null,
) {
    val focusAlert: Boolean get() = focus == "left" || focus == "away"
}

/**
 * Same rules as the web teacher (apps/web/src/lib/classSlots.ts), kept pure so
 * they are JVM unit-tested (ClassLogicTest).
 */
object ClassLogic {
    /** Student tiles in the video column next to the teacher's own. */
    const val STUDENT_TILES = 3

    /**
     * Which students fill the tiles: teacher-pinned (oldest pin first), then
     * the active speaker, then sticky unmuted speakers, then the rotation.
     * Only students actually publishing a camera ([pool]) are shown.
     */
    fun pickTiles(
        pool: List<String>,
        teacherPins: List<String>,
        speakingId: String?,
        sticky: Collection<String>,
        rotation: List<String>,
        slots: Int,
    ): List<String> {
        val inPool = pool.toSet()
        val out = ArrayList<String>()
        fun push(id: String) {
            if (out.size < slots && id in inPool && id !in out) out.add(id)
        }
        teacherPins.forEach(::push)
        speakingId?.let(::push)
        sticky.forEach(::push)
        rotation.forEach(::push)
        pool.forEach(::push)
        return out
    }

    /** Pinned identities, oldest pin first. */
    fun pinOrder(students: List<StudentInfo>): List<String> =
        students.filter { it.pinned }.sortedWith(compareBy({ it.pinnedAt ?: Long.MAX_VALUE }, { it.identity })).map { it.identity }

    /** Raised hands first (earliest raise first, unknown times last), then by name. */
    fun sortRoster(students: List<StudentInfo>): List<StudentInfo> =
        students.sortedWith(
            compareBy<StudentInfo>({ !it.handRaised }, { if (it.handRaised) it.handRaisedAt ?: Long.MAX_VALUE else 0L })
                .thenBy(String.CASE_INSENSITIVE_ORDER) { it.name },
        )

    /** Rotate the order by one (the next student moves to the front). */
    fun rotate(order: List<String>): List<String> = if (order.size > 1) order.drop(1) + order.first() else order

    fun parseStudents(admitted: JSONArray?): List<StudentInfo> {
        if (admitted == null) return emptyList()
        val out = ArrayList<StudentInfo>()
        for (i in 0 until admitted.length()) {
            val a = admitted.optJSONObject(i) ?: continue
            if (a.optString("role") != "STUDENT") continue
            out.add(
                StudentInfo(
                    id = a.optString("id"),
                    identity = a.optString("livekitIdentity"),
                    name = a.optString("displayName", "Student"),
                    handRaised = a.optBoolean("handRaised"),
                    handRaisedAt = a.optLongOrNull("handRaisedAt"),
                    pinned = a.optBoolean("pinned"),
                    pinnedAt = a.optLongOrNull("pinnedAt"),
                    muted = a.optBoolean("mutedByTeacher"),
                    focus = a.optString("focus").ifBlank { null },
                ),
            )
        }
        return out
    }

    private fun JSONObject.optLongOrNull(key: String): Long? =
        if (!has(key) || isNull(key)) null else optLong(key).takeIf { it > 0 }
}
