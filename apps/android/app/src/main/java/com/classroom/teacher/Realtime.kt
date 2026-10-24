package com.classroom.teacher

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min

/** Realtime protocol helpers shared with the web app (lib/realtimePackets.ts, lib/drawLogic.ts). Pure JVM. */
object Realtime {
    const val STATE_TOPIC = "cls-state"
    const val CHAT_TOPIC = "chat"
    const val SIGNAL_TOPIC = "cls-signal"
    const val DRAW_TOPIC = "draw"

    enum class Sender { SERVER, TEACHER, STUDENT, OTHER }

    fun senderKind(identity: String?): Sender = when {
        identity.isNullOrEmpty() -> Sender.SERVER
        identity.startsWith("teacher_") && !identity.endsWith("__screen") -> Sender.TEACHER
        identity.startsWith("student_") -> Sender.STUDENT
        else -> Sender.OTHER
    }

    sealed class Signal {
        data class Hand(val raised: Boolean, val participantId: String) : Signal()
        data class DrawReq(val on: Boolean, val participantId: String) : Signal()
        data class DrawAllow(val on: Boolean, val participantId: String, val identity: String, val name: String, val until: Long) : Signal()
    }

    private fun pid(o: JSONObject): String? = (o.opt("participantId") as? String)?.takeIf { it.length in 1..64 }

    fun decodeSignal(bytes: ByteArray): Signal? {
        val o = try { JSONObject(String(bytes, Charsets.UTF_8)) } catch (_: Exception) { return null }
        if (o.opt("v") != 1) return null
        val id = pid(o) ?: return null
        return when (o.opt("type")) {
            "hand" -> (o.opt("raised") as? Boolean)?.let { Signal.Hand(it, id) }
            "draw-req" -> (o.opt("on") as? Boolean)?.let { Signal.DrawReq(it, id) }
            "draw-allow" -> {
                val on = o.opt("on") as? Boolean ?: return null
                val identity = (o.opt("identity") as? String)?.takeIf { it.length <= 128 } ?: return null
                val name = (o.opt("name") as? String)?.takeIf { it.length <= 200 } ?: return null
                val until = (o.opt("until") as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: return null
                Signal.DrawAllow(on, id, identity, name, until.toLong())
            }
            else -> null
        }
    }

    /** Teacher side of signalPacketTrusted: server and teachers only (a student may only speak for itself, never to us). */
    fun signalTrusted(s: Signal, senderIdentity: String?): Boolean {
        val kind = senderKind(senderIdentity)
        if (s is Signal.DrawAllow) return kind == Sender.SERVER
        return kind == Sender.SERVER || kind == Sender.TEACHER
    }

    // ---- screen ink (topic `draw`) ----
    val DRAW_COLORS = mapOf("red" to 0xFFEF4444.toInt(), "yellow" to 0xFFFACC15.toInt(), "blue" to 0xFF3B82F6.toInt())
    const val DRAW_ALLOW_MS = 3 * 60 * 1000L
    const val MAX_DRAWERS = 6
    const val MAX_STROKES = 400
    const val MAX_STROKE_POINTS = 1200
    private val STROKE_ID = Regex("^[A-Za-z0-9_-]{4,40}$")

    data class InkStroke(val id: String, val by: String, val name: String, val color: String, val pts: FloatArray)

    sealed class Ink {
        data class Pts(val id: String, val by: String, val name: String, val c: String, val from: Int, val pts: FloatArray) : Ink()
        data class Del(val id: String) : Ink()
        object Clear : Ink()
    }

    private fun q(n: Double): Float = (Math.round(min(1.0, max(0.0, n)) * 10000) / 10000.0).toFloat()

    private fun cleanPoints(raw: Any?, maxPts: Int): FloatArray? {
        val a = raw as? JSONArray ?: return null
        if (a.length() < 2 || a.length() % 2 != 0 || a.length() > maxPts * 2) return null
        return FloatArray(a.length()) { i ->
            val v = (a.opt(i) as? Number)?.toDouble() ?: return null
            if (!v.isFinite() || v < -0.01 || v > 1.01) return null
            q(v)
        }
    }

    fun decodeInk(raw: JSONObject): Ink? {
        if (raw.opt("v") != 1) return null
        return when (raw.opt("t")) {
            "clear" -> Ink.Clear
            "del" -> (raw.opt("id") as? String)?.takeIf { STROKE_ID.matches(it) }?.let { Ink.Del(it) }
            "pts" -> {
                val id = (raw.opt("id") as? String)?.takeIf { STROKE_ID.matches(it) } ?: return null
                val by = raw.opt("by") as? String ?: return null
                val name = raw.opt("name") as? String ?: return null
                val c = (raw.opt("c") as? String)?.takeIf { it in DRAW_COLORS } ?: return null
                val pts = cleanPoints(raw.opt("pts"), MAX_STROKE_POINTS) ?: return null
                val f = raw.opt("from")
                val from = if (f is Int && f >= 0) f else 0
                Ink.Pts(id, by, name.take(80), c, from, pts)
            }
            else -> null
        }
    }

    /** Trust rule for `draw`: server/teacher anything; a student only its own `pts`. */
    fun inkTrusted(p: Ink, senderIdentity: String?): Boolean = when (senderKind(senderIdentity)) {
        Sender.SERVER, Sender.TEACHER -> true
        Sender.STUDENT -> p is Ink.Pts && p.by == senderIdentity
        Sender.OTHER -> false
    }

    /** Apply an ink packet in place (web applyPacket; idempotent append at `from`). */
    fun applyInk(strokes: MutableList<InkStroke>, p: Ink) {
        when (p) {
            is Ink.Clear -> strokes.clear()
            is Ink.Del -> strokes.removeAll { it.id == p.id }
            is Ink.Pts -> {
                val i = strokes.indexOfFirst { it.id == p.id }
                if (i < 0) {
                    if (strokes.size < MAX_STROKES) strokes.add(InkStroke(p.id, p.by, p.name, p.c, p.pts.copyOf(min(p.pts.size, MAX_STROKE_POINTS * 2))))
                } else {
                    val cur = strokes[i]
                    val start = min(cur.pts.size, max(0, p.from))
                    val n = min(start + p.pts.size, MAX_STROKE_POINTS * 2)
                    val out = FloatArray(n)
                    System.arraycopy(cur.pts, 0, out, 0, start)
                    System.arraycopy(p.pts, 0, out, start, n - start)
                    strokes[i] = cur.copy(pts = out)
                }
            }
        }
    }

    /** GET /draw strokes → ink strokes (late join). */
    fun parseInkStrokes(arr: JSONArray?): MutableList<InkStroke> {
        val out = ArrayList<InkStroke>()
        if (arr == null) return out
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val color = o.optString("color", o.optString("c"))
            val p = decodeInk(JSONObject().put("v", 1).put("t", "pts").put("id", o.optString("id")).put("by", o.optString("by"))
                .put("name", o.optString("name")).put("c", color).put("from", 0).put("pts", o.optJSONArray("pts") ?: JSONArray())) as? Ink.Pts ?: continue
            applyInk(out, p)
        }
        return out
    }

    fun drawersLabel(names: List<String>): String = when (names.size) {
        0 -> ""
        1 -> "${names[0]} is drawing"
        2 -> "${names[0]} and ${names[1]} are drawing"
        3 -> "${names[0]}, ${names[1]} and ${names[2]} are drawing"
        else -> "${names[0]}, ${names[1]} and ${names.size - 2} more are drawing"
    }

    /** Class-full wording from the Windows app (admit → 409). */
    fun classFullMessage(err: String?): String = "${err?.takeIf { it.isNotBlank() } ?: "This class is full."} Remove a student or raise the class size limit to admit more."

    /** Poll cadence: fast while someone waits, normal live, slow (30 s) while the app is in the background. */
    fun pollMs(visible: Boolean, fast: Boolean): Long = when {
        !visible -> 30_000L
        fast -> 2_000L
        else -> 5_000L
    }

    /** Chat `?since` cursor: newest createdAt (ISO) we hold; the server applies a 5 s overlap, so merge by id. */
    fun <T> mergeById(old: List<T>, fresh: List<T>, id: (T) -> String, max: Int = 500): List<T> {
        if (fresh.isEmpty()) return old
        val seen = HashMap<String, Int>()
        val out = ArrayList(old)
        out.forEachIndexed { i, m -> seen[id(m)] = i }
        for (m in fresh) {
            val i = seen[id(m)]
            if (i != null) out[i] = m else { seen[id(m)] = out.size; out.add(m) }
        }
        return if (out.size > max) out.subList(out.size - max, out.size).toList() else out
    }

    /** Screen-share simulcast: one 720p layer (long side 1280) when the capture is big enough (web screenShareSimulcastFor). */
    fun shareLowLayer(capW: Int, capH: Int): Pair<Int, Int>? {
        val long = max(capW, capH)
        if (long < 1280 * 1.25) return null
        val s = 1280.0 / long
        return (Math.round(capW * s / 2.0) * 2).toInt() to (Math.round(capH * s / 2.0) * 2).toInt()
    }
}

/** Crash/error reports for /api/client-error: scrubbed, at most 5 a minute, each distinct error once (Windows errorReport.ts). */
class ErrorReporter(private val clock: () -> Long = System::currentTimeMillis) {
    private val sent = ArrayList<Long>()
    private val seen = HashSet<String>()

    @Synchronized
    fun admit(key: String): Boolean {
        val now = clock()
        sent.removeAll { now - it > 60_000 }
        if (key in seen || sent.size >= 5) return false
        seen.add(key)
        sent.add(now)
        return true
    }

    companion object {
        private val JWT = Regex("eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}")
        private val QUERY = Regex("([?&#])[^\\s'\")]*")
        private val SECRETS = Regex("(?i)(token|password|secret|cookie|authorization|session)([\"']?\\s*[=:]\\s*[\"']?)[^\\s\"'&,;]+")

        fun scrub(s: String?, maxLen: Int = 4000): String {
            if (s == null) return ""
            return s.replace(JWT, "[jwt]").replace(QUERY, "$1…").replace(SECRETS, "$1$2[redacted]").take(maxLen)
        }

        fun payload(t: Throwable, code: String, url: String, ua: String, attempt: Int = 0): JSONObject {
            val stack = t.stackTrace.take(40).joinToString("\n") { "    at $it" }
            return JSONObject()
                .put("code", code.take(32))
                .put("message", scrub(t.message ?: t.toString(), 500))
                .put("name", t.javaClass.simpleName.take(80))
                .put("stack", scrub(t.javaClass.name + "\n" + stack, 4000))
                .put("componentStack", "")
                .put("url", scrub(url, 300))
                .put("ua", ua.take(300))
                .put("at", System.currentTimeMillis())
                .put("attempt", attempt)
        }
    }
}

