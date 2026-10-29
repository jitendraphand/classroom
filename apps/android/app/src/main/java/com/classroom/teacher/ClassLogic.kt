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
    val drawRequested: Boolean = false,
    val drawRequestedAt: Long? = null,
    /** Allowed to draw on the share / whiteboard now. */
    val drawing: Boolean = false,
    /** Heartbeat late: still listed, shown as "Reconnecting". */
    val reconnecting: Boolean = false,
    /** In the speaking queue (mic limit reached). */
    val micWaiting: Boolean = false,
    /** School SID (externalId), for search. */
    val sid: String? = null,
) {
    val focusAlert: Boolean get() = focus == "left" || focus == "away"
}

/**
 * Same rules as the web teacher (apps/web/src/lib/classSlots.ts), kept pure so
 * they are JVM unit-tested (ClassLogicTest).
 */
object ClassLogic {
    /** What the server says about app updates (GET /api/desktop/android), as a banner for the home screen. */
    data class UpdateNotice(val required: Boolean, val latest: String, val url: String?)

    /** "1.2.0-20261028" -> [1, 2, 0]; null when there is no x.y.z at the start. */
    fun versionParts(v: String?): List<Int>? {
        val m = Regex("""^(\d+)\.(\d+)\.(\d+)""").find(v?.trim() ?: return null) ?: return null
        return m.groupValues.drop(1).map { it.toInt() }
    }

    fun versionLess(a: List<Int>, b: List<Int>): Boolean {
        for (i in 0 until 3) if (a[i] != b[i]) return a[i] < b[i]
        return false
    }

    /**
     * Below `minimum`: an update is required; below `latest`: one is available;
     * otherwise nothing. Same rules as the Windows app (web lib/desktopApp).
     */
    fun updateNotice(current: String, latest: String?, minimum: String?, url: String?): UpdateNotice? {
        val cur = versionParts(current) ?: return null
        val min = versionParts(minimum)
        val lat = versionParts(latest)
        if (min != null && versionLess(cur, min)) return UpdateNotice(true, (lat?.takeIf { !versionLess(it, min) } ?: min).joinToString("."), url)
        if (lat != null && versionLess(cur, lat)) return UpdateNotice(false, lat.joinToString("."), url)
        return null
    }

    /** Large classes: rows rendered per page in the roster / waiting list (web lib/rosterWindow ROSTER_PAGE). */
    const val ROSTER_PAGE = 150

    /** First [limit] rows (at least a page), how many are hidden, and how many "Show more" adds (web rosterWindow). */
    fun <T> rosterWindow(rows: List<T>, limit: Int): Triple<List<T>, Int, Int> {
        val n = maxOf(ROSTER_PAGE, limit)
        val shown = if (rows.size > n) rows.subList(0, n) else rows
        val hidden = rows.size - shown.size
        return Triple(shown, hidden, minOf(hidden, ROSTER_PAGE))
    }

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
            compareBy<StudentInfo>({ !it.handRaised }, { if (it.handRaised) it.handRaisedAt ?: Long.MAX_VALUE else 0L }, { !it.drawRequested })
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
                    drawRequested = a.optBoolean("drawRequested"),
                    drawRequestedAt = a.optLongOrNull("drawRequestedAt"),
                    drawing = a.optBoolean("drawing"),
                    reconnecting = a.optBoolean("reconnecting"),
                    micWaiting = a.optBoolean("micWaiting"),
                    sid = if (a.isNull("sid")) null else a.optString("sid").ifBlank { null },
                ),
            )
        }
        return out
    }

    /** Roster search: name or SID, case-insensitive (Windows "Search name or SID…"). */
    fun matches(s: StudentInfo, query: String): Boolean {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return true
        return s.name.lowercase().contains(q) || (s.sid?.lowercase()?.contains(q) ?: false)
    }

    data class MicWaiter(val id: String, val name: String, val position: Int)

    /** Material window size class by width: 0 compact (< 600dp), 1 medium (< 840dp), 2 expanded. */
    fun windowClass(widthDp: Int): Int = when {
        widthDp < 600 -> 0
        widthDp < 840 -> 1
        else -> 2
    }

    fun parseMicQueue(arr: JSONArray?): List<MicWaiter> {
        if (arr == null) return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            MicWaiter(o.optString("id"), o.optString("name", "Student"), o.optInt("position", i + 1))
        }.sortedBy { it.position }
    }

    private fun JSONObject.optLongOrNull(key: String): Long? =
        if (!has(key) || isNull(key)) null else optLong(key).takeIf { it > 0 }
}

/** Chat rules shared with the web teacher (apps/web/src/lib/chatReply.ts). Pure, JVM-tested. */
object ChatLogic {
    /** One line of the chat log. Private messages are marked, so a teacher never answers one in public by mistake. */
    fun line(m: JSONObject): String {
        val name = m.optString("senderName").ifBlank { "Someone" }
        val body = m.optString("body")
        return when (m.optString("scope")) {
            "TEACHER" -> "$name (private, to you): $body"
            "DIRECT" -> "You \u2192 ${m.optString("recipientName").ifBlank { "a student" }} (private): $body"
            else -> "$name: $body"
        }
    }

    /** The newest message is a student's private question: (participantId, name) to offer "Reply privately". */
    fun pendingPrivateQuestion(messages: List<JSONObject>): Pair<String, String>? {
        val last = messages.lastOrNull() ?: return null
        if (last.optString("scope") != "TEACHER" || last.optString("senderRole") != "STUDENT") return null
        val id = last.optString("senderParticipantId").takeIf { it.isNotBlank() } ?: return null
        return id to last.optString("senderName").ifBlank { "the student" }
    }
}

/**
 * Server address rules. Plain http:// sends the password and the session
 * cookie unencrypted, so it is only allowed to a server on this network
 * (private / loopback / link-local addresses, *.local); anything on the
 * internet must be https://.
 */
object ServerAddress {
    const val EXAMPLE = "https://classes.example.org"

    /** Why this address cannot be used, or null when it is fine. */
    fun problem(raw: String): String? {
        val uri = try {
            java.net.URI(raw.trim())
        } catch (_: Exception) {
            return "Enter a server address like $EXAMPLE"
        }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "https" && scheme != "http") return "The server address must start with https://"
        val host = uri.host?.lowercase()?.removePrefix("[")?.removeSuffix("]")
        if (host.isNullOrBlank()) return "Enter a server address like $EXAMPLE"
        if (uri.rawUserInfo != null) return "Leave the user name and password out of the server address"
        if (scheme == "http" && !onThisNetwork(host)) {
            return "Use https:// for a server on the internet. Plain http:// only works for a server on the school network (for example http://192.168.1.10)."
        }
        return null
    }

    fun onThisNetwork(host: String): Boolean {
        val h = host.lowercase().removePrefix("[").removeSuffix("]")
        if (h == "localhost" || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true
        val v4 = h.split('.').takeIf { it.size == 4 }?.map { it.toIntOrNull() ?: return false }
        if (v4 != null) {
            if (v4.any { it !in 0..255 }) return false
            val (a, b) = v4[0] to v4[1]
            return a == 10 || a == 127 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254)
        }
        if (h.contains(':')) return h == "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")
        return false
    }
}
