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

/** A grade on one campus the teacher may start an ad-hoc class for (the server needs the campus too). */
data class GradeChoice(
    val campus: String,
    val grade: String,
    val label: String,
    val divisions: List<Pair<String, String>>,
    val allowAll: Boolean,
)

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

    /**
     * Who is signed in. The server ends teacher sessions after 24 h without
     * use and renews the cookie on this call, so the app calls it while open.
     */
    fun me(): JSONObject {
        val res = call("GET", "/api/auth/me", null)
        // A captive portal or proxy page is not an answer: only the server's own "role" counts.
        if (!res.has("role")) throw ApiException("The server did not answer as expected.")
        if (res.optString("role") != "teacher") {
            val reason = res.optString("reason").takeIf { it.isNotBlank() && it != "null" }
            teacherCookie = null
            throw SessionEndedException(reason)
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
            grades.add(GradeChoice(g.optString("campus"), name, g.optString("label", name), list, g.optBoolean("whole", false)))
        }
        val activeCode = active?.optString("code")?.takeIf { it.isNotBlank() }
        val activeLabel = active?.let {
            listOf(it.optString("subject"), it.optString("audience")).filter { s -> s.isNotBlank() }.joinToString(" · ")
        }
        return Schedule(activeCode, activeLabel, today, grades)
    }

    fun startScheduled(key: String): JSONObject =
        call("POST", "/api/teacher/sessions/start", JSONObject().put("kind", "scheduled").put("key", key))

    fun startAdHoc(campus: String, grade: String, division: String?, subject: String): JSONObject {
        val body = JSONObject().put("kind", "adhoc").put("campus", campus).put("grade", grade)
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

    /** Stage mode; [desktopInk] = the teacher burns student ink into the captured screen (web viewers skip their overlay). */
    fun stage(code: String, mode: String, desktopInk: Boolean? = null) {
        val body = JSONObject().put("mode", mode)
        if (desktopInk != null) body.put("desktopInk", desktopInk)
        call("POST", "/api/rooms/${code.uppercase()}/stage", body)
    }

    /** Student-video panel open/closed (students only publish cameras while someone watches). */
    fun videoPanel(code: String, open: Boolean) {
        call("POST", "/api/rooms/${code.uppercase()}/video-panel", JSONObject().put("open", open))
    }

    /** Spotlight one student for everyone (null = stop). */
    fun spotlight(code: String, participantId: String?) {
        call("POST", "/api/rooms/${code.uppercase()}/spotlight", JSONObject().put("participantId", participantId ?: JSONObject.NULL))
    }

    /** Screen / whiteboard drawing: allow, revoke (null id = everyone), clear, erase. */
    fun draw(code: String, action: String, participantId: String? = null, ids: List<String>? = null): JSONObject {
        val body = JSONObject().put("action", action)
        if (participantId != null) body.put("participantId", participantId)
        if (ids != null) body.put("ids", JSONArray(ids))
        return call("POST", "/api/rooms/${code.uppercase()}/draw", body)
    }

    /** Draw holders + strokes (late join). */
    fun drawState(code: String): JSONObject = call("GET", "/api/rooms/${code.uppercase()}/draw", null)

    /** Whiteboard: on / off, or store the latest snapshot (base64 wire packets). */
    fun whiteboard(code: String, action: String, packets: List<String>? = null) {
        val body = JSONObject().put("action", action)
        if (packets != null) body.put("packets", JSONArray(packets))
        call("POST", "/api/rooms/${code.uppercase()}/whiteboard", body)
    }

    /** Crash report (no auth, best effort, never throws). */
    fun clientError(report: JSONObject) {
        try {
            if (ServerAddress.problem(base) != null) return
            val text = report.toString()
            if (text.length > CLIENT_ERROR_MAX) return
            val req = Request.Builder().url("$base/api/client-error").post(text.toRequestBody(jsonType)).build()
            client.newCall(req).execute().close()
        } catch (_: Exception) {
        }
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
    /** Waiting room on/off for the running class session (off admits everyone waiting). */
    fun setWaitingRoom(code: String, on: Boolean) {
        call("PATCH", "/api/rooms/${code.uppercase()}/settings", JSONObject().put("waitingRoomOn", on))
    }

    fun setVideoCap(code: String, max: Int) {
        call("PATCH", "/api/rooms/${code.uppercase()}/settings", JSONObject().put("maxVisibleVideos", max))
    }

    /** Chat; [since] (ISO) returns only newer messages (server keeps a 5 s overlap). */
    fun messages(code: String, since: String? = null): JSONObject {
        val q = if (since.isNullOrBlank()) "" else "?since=" + java.net.URLEncoder.encode(since, "UTF-8")
        return call("GET", "/api/rooms/${code.uppercase()}/messages$q", null)
    }

    /** Chat to everyone ([to] null) or privately to one student (participant id). */
    fun sendMessage(code: String, text: String, to: String? = null) {
        call("POST", "/api/rooms/${code.uppercase()}/messages", JSONObject().put("text", text).put("to", to ?: "all"))
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
        // The password and session cookie never go over plain http to a public address.
        ServerAddress.problem(base)?.let { throw ApiException(it) }
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
        /** Pre-filled server address (set at build time: CLASSROOM_DEFAULT_SERVER). */
        val DEFAULT_SERVER: String = BuildConfig.DEFAULT_SERVER

        /** The server rejects reports over 8 KB (413). */
        const val CLIENT_ERROR_MAX = 7_500
    }
}
