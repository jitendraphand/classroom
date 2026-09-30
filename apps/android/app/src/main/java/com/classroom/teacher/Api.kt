package com.classroom.teacher

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class ApiException(message: String) : Exception(message)

/**
 * Talks to the existing classroom web server. The teacher session is the
 * httpOnly cookie from login; OkHttp would drop SameSite on some Android
 * versions, so the cookie is stored and sent explicitly.
 */
class ClassroomApi(rawBase: String) {
    val base: String = rawBase.trim().trimEnd('/')

    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    var teacherCookie: String? = null

    fun login(email: String, password: String): JSONObject {
        val body = JSONObject()
            .put("email", email.trim())
            .put("password", password)
        return call("POST", "/api/auth/login", body, captureTeacherCookie = true)
    }

    fun me(): JSONObject = call("GET", "/api/auth/me", null)

    fun startClass(name: String, maxVisibleVideos: Int): JSONObject {
        val body = JSONObject()
            .put("name", name.ifBlank { "Class" })
            .put("maxVisibleVideos", maxVisibleVideos.coerceIn(1, 6))
        return call("POST", "/api/rooms/create", body)
    }

    fun state(code: String): JSONObject = call("GET", "/api/rooms/${code.uppercase()}/state", null)

    fun admit(code: String, participantId: String) {
        val ids = JSONArray().put(participantId)
        call("POST", "/api/rooms/${code.uppercase()}/admit", JSONObject().put("participantIds", ids))
    }

    fun admitAll(code: String) {
        call("POST", "/api/rooms/${code.uppercase()}/admit", JSONObject().put("all", true))
    }

    fun token(code: String): JSONObject = call("GET", "/api/rooms/${code.uppercase()}/token", null)

    fun stage(code: String, mode: String) {
        call("POST", "/api/rooms/${code.uppercase()}/stage", JSONObject().put("mode", mode))
    }

    fun muteAll(code: String, muted: Boolean) {
        call(
            "POST",
            "/api/rooms/${code.uppercase()}/mute",
            JSONObject().put("all", true).put("muted", muted),
        )
    }

    fun messages(code: String): JSONObject = call("GET", "/api/rooms/${code.uppercase()}/messages", null)

    fun sendBroadcast(code: String, text: String) {
        call(
            "POST",
            "/api/rooms/${code.uppercase()}/messages",
            JSONObject().put("text", text).put("to", "all"),
        )
    }

    fun end(code: String) {
        call("POST", "/api/rooms/${code.uppercase()}/end", JSONObject())
    }

    fun leave(code: String) {
        call("POST", "/api/rooms/${code.uppercase()}/leave", JSONObject())
    }

    private fun call(
        method: String,
        path: String,
        body: JSONObject?,
        captureTeacherCookie: Boolean = false,
    ): JSONObject {
        val builder = Request.Builder().url(base + path)
        teacherCookie?.let { builder.header("Cookie", it) }
        when {
            body != null -> builder.method(method, body.toString().toRequestBody(jsonType))
            method == "GET" -> builder.get()
            else -> builder.method(method, ByteArray(0).toRequestBody(null))
        }
        client.newCall(builder.build()).execute().use { response ->
            if (captureTeacherCookie) {
                // HTTPS deploys use the `__Host-` prefixed name (see web lib/auth.ts).
                response.headers("Set-Cookie")
                    .firstOrNull {
                        it.startsWith("__Host-classroom_teacher=") || it.startsWith("classroom_teacher=")
                    }
                    ?.substringBefore(';')
                    ?.let { teacherCookie = it }
            }
            val text = response.body?.string().orEmpty()
            val json = if (text.trimStart().startsWith("{")) JSONObject(text) else JSONObject()
            if (!response.isSuccessful) {
                throw ApiException(json.optString("error").ifBlank { "Request failed (${response.code})" })
            }
            return json
        }
    }
}
