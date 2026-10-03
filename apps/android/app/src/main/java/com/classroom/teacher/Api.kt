package com.classroom.teacher

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

open class ApiException(message: String, val status: Int = 0) : Exception(message)

/**
 * The teacher's session is no longer the account's active one. The server
 * keeps ONE signed-in session per teacher: signing in on another device (or the
 * website) replaces this one. `reason` is the server's code
 * (signed_in_elsewhere, revoked, disabled, expired, signed_out).
 */
class SessionEndedException(val reason: String?) : ApiException(messageFor(reason), 401) {
    companion object {
        fun messageFor(reason: String?): String = when (reason) {
            "signed_in_elsewhere" ->
                "You signed in on another device, so this device was signed out. Sign in again to use it here."
            "revoked" -> "Your session was ended by the school admin. Sign in again."
            "disabled" -> "This account is disabled. Contact the school administrator."
            "expired" -> "Your session expired. Sign in again."
            else -> "You are signed out. Sign in again."
        }
    }
}

/** A class the teacher can start or rejoin (timetabled occurrence or the running class). */
data class ClassChoice(
    val key: String,
    val subject: String,
    val audience: String,
    val timeLabel: String,
    val canStart: Boolean,
    val live: Boolean,
)

data class GradeChoice(val grade: String, val label: String, val divisions: List<Pair<String, String>>, val allowAll: Boolean)

data class Schedule(
    val activeCode: String?,
    val activeLabel: String?,
    val today: List<ClassChoice>,
    val grades: List<GradeChoice>,
)

/**
 * Talks to the classroom web server. The teacher session is the httpOnly
 * cookie from login; it is stored and sent explicitly (OkHttp has no cookie
 * jar here). Over HTTPS the cookie is `__Host-classroom_teacher`.
 */
class ClassroomApi(rawBase: String) {
    val base: String = rawBase.trim().trimEnd('/')

    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    /** Called when the server sets or clears the session cookie (to persist it). */
    var onCookieChange: ((String?) -> Unit)? = null

    @Volatile
    var teacherCookie: String? = null
        set(value) {
            val changed = field != value
            field = value
            if (changed) onCookieChange?.invoke(value)
        }

    fun login(email: String, password: String): JSONObject {
        val body = JSONObject().put("email", email.trim()).put("password", password)
        val res = call("POST", "/api/auth/login", body, sessionCall = false)
        if (res.optString("role") == "admin") {
            teacherCookie = null
            throw ApiException("This is the school admin account. Sign in with a teacher account.")
        }
        if (teacherCookie == null) throw ApiException("The server did not start a session. Check the server address.")
        if (res.optBoolean("mustChangePassword", false)) {
            teacherCookie = null
            throw ApiException("Set your own password first: open $base/login in a browser, then sign in here.")
        }
        return res
    }

    fun logout() {
        try {
            call("POST", "/api/auth/logout", JSONObject(), sessionCall = false)
        } finally {
            teacherCookie = null
        }
    }

    /** Today's classes (plus the running one) and the grades this teacher may start ad-hoc classes for. */
    fun schedule(): Schedule {
        val res = call("GET", "/api/teacher/schedule", null)
        val todayDate = res.optString("today")
        val active = res.optJSONObject("active")
        val classes = res.optJSONArray("classes") ?: JSONArray()
        val today = ArrayList<ClassChoice>()
        for (i in 0 until classes.length()) {
            val c = classes.getJSONObject(i)
            if (c.optString("date") != todayDate) continue
            val session = c.optJSONObject("session")
            today.add(
                ClassChoice(
                    key = c.optString("key"),
                    subject = c.optString("subject"),
                    audience = c.optString("audience"),
                    timeLabel = "${c.optString("startLabel")}–${c.optString("endLabel")}",
                    canStart = c.optBoolean("canStart"),
                    live = session?.optBoolean("live") == true,
                ),
            )
        }
        val grades = ArrayList<GradeChoice>()
        val gc = res.optJSONArray("gradeChoices") ?: JSONArray()
        for (i in 0 until gc.length()) {
            val g = gc.getJSONObject(i)
            val divs = g.optJSONArray("divisions") ?: JSONArray()
            val list = ArrayList<Pair<String, String>>()
            for (j in 0 until divs.length()) {
                when (val d = divs.get(j)) {
                    is JSONObject -> list.add(d.optString("name") to d.optString("label", d.optString("name")))
                    else -> list.add(d.toString() to d.toString())
                }
            }
            val name = g.optString("grade", g.optString("name"))
            grades.add(GradeChoice(name, g.optString("label", name), list, g.optBoolean("whole", false)))
        }
        val activeCode = active?.optString("code")?.takeIf { it.isNotBlank() }
        val activeLabel = active?.let {
            listOf(it.optString("subject"), it.optString("audience")).filter { s -> s.isNotBlank() }.joinToString(" · ")
        }
        return Schedule(activeCode, activeLabel, today, grades)
    }

    fun startScheduled(key: String): JSONObject =
        call("POST", "/api/teacher/sessions/start", JSONObject().put("kind", "scheduled").put("key", key))

    fun startAdHoc(grade: String, division: String?, subject: String): JSONObject {
        val body = JSONObject().put("kind", "adhoc").put("grade", grade)
        if (division == null) body.put("allDivisions", true).put("divisions", JSONArray())
        else body.put("allDivisions", false).put("divisions", JSONArray().put(division))
        if (subject.isNotBlank()) body.put("subject", subject)
        return call("POST", "/api/teacher/sessions/start", body)
    }

    fun state(code: String): JSONObject = call("GET", "/api/rooms/${code.uppercase()}/state", null)

    fun admit(code: String, participantId: String) {
        call("POST", "/api/rooms/${code.uppercase()}/admit", JSONObject().put("participantIds", JSONArray().put(participantId)))
    }

    fun admitAll(code: String) {
        call("POST", "/api/rooms/${code.uppercase()}/admit", JSONObject().put("all", true))
    }

    fun token(code: String): JSONObject = call("GET", "/api/rooms/${code.uppercase()}/token", null)

    fun stage(code: String, mode: String) {
        call("POST", "/api/rooms/${code.uppercase()}/stage", JSONObject().put("mode", mode))
    }

    fun muteAll(code: String, muted: Boolean) {
        call("POST", "/api/rooms/${code.uppercase()}/mute", JSONObject().put("all", true).put("muted", muted))
    }

    /** Mute / unmute one student (server-side mic lock). */
    fun muteOne(code: String, participantId: String, muted: Boolean) {
        call("POST", "/api/rooms/${code.uppercase()}/mute", JSONObject().put("participantId", participantId).put("muted", muted))
    }

    /** Pin / unpin a student's video (persisted for this class session; counts toward the video cap). */
    fun pinStudent(code: String, participantId: String, pinned: Boolean) {
        call("POST", "/api/rooms/${code.uppercase()}/pin-student", JSONObject().put("participantId", participantId).put("pinned", pinned))
    }

    fun lowerHand(code: String, participantId: String) {
        call("POST", "/api/rooms/${code.uppercase()}/hand", JSONObject().put("participantId", participantId).put("raised", false))
    }

    /** How many student cameras the server lets publish at once (1–6). */
    fun setVideoCap(code: String, max: Int) {
        call("PATCH", "/api/rooms/${code.uppercase()}/settings", JSONObject().put("maxVisibleVideos", max))
    }

    fun messages(code: String): JSONObject = call("GET", "/api/rooms/${code.uppercase()}/messages", null)

    fun sendBroadcast(code: String, text: String) {
        call("POST", "/api/rooms/${code.uppercase()}/messages", JSONObject().put("text", text).put("to", "all"))
    }

    fun end(code: String) {
        call("POST", "/api/rooms/${code.uppercase()}/end", JSONObject())
    }

    fun leave(code: String) {
        call("POST", "/api/rooms/${code.uppercase()}/leave", JSONObject())
    }

    /** Why the session ended (GET /api/auth/status), or null if it is still fine / unknown. */
    private fun sessionReason(): String? = try {
        val res = rawCall("GET", "/api/auth/status", null).second
        res.optString("reason").takeIf { it.isNotBlank() && it != "null" }
    } catch (_: Exception) {
        null
    }

    private fun call(method: String, path: String, body: JSONObject?, sessionCall: Boolean = true): JSONObject {
        val (code, json) = rawCall(method, path, body)
        if (code in 200..299) return json
        if (code == 401 && sessionCall) {
            val reason = json.optString("reason").takeIf { it.isNotBlank() && it != "null" } ?: sessionReason()
            teacherCookie = null
            throw SessionEndedException(reason)
        }
        if (code == 410) throw ApiException(json.optString("error").ifBlank { "Class ended" }, 410)
        throw ApiException(json.optString("error").ifBlank { "Request failed ($code)" }, code)
    }

    private fun rawCall(method: String, path: String, body: JSONObject?): Pair<Int, JSONObject> {
        val builder = Request.Builder().url(base + path)
        teacherCookie?.let { builder.header("Cookie", it) }
        when {
            body != null -> builder.method(method, body.toString().toRequestBody(jsonType))
            method == "GET" -> builder.get()
            else -> builder.method(method, ByteArray(0).toRequestBody(null))
        }
        client.newCall(builder.build()).execute().use { response ->
            // Login sets the cookie; logout / a dead session clears it (empty value).
            response.headers("Set-Cookie")
                .firstOrNull { it.startsWith("__Host-classroom_teacher=") || it.startsWith("classroom_teacher=") }
                ?.substringBefore(';')
                ?.let { teacherCookie = if (it.substringAfter('=').isBlank()) null else it }
            val text = response.body?.string().orEmpty()
            val json = try {
                if (text.trimStart().startsWith("{")) JSONObject(text) else JSONObject()
            } catch (_: Exception) {
                JSONObject()
            }
            return response.code to json
        }
    }

    companion object {
        const val DEFAULT_SERVER = "https://13-201-89-150.sslip.io"
    }
}
