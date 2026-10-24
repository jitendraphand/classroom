package com.classroom.teacher.wb

import org.json.JSONObject

/**
 * Teacher-side whiteboard session (web WhiteboardHost + WhiteboardSession):
 * this device owns the board. Local edits are applied, published on topic
 * `wb` and kept on an undo stack. Student packets are accepted only when the
 * student currently holds draw permission (or the server relayed them) and
 * only for their own pen strokes. `req` packets and late joiners get a
 * snapshot. Pure JVM logic (unit-tested); MainActivity does the I/O.
 */
class WbHost(
    var doc: Doc,
    private val send: (packets: List<ByteArray>, to: List<String>?) -> Unit,
) {
    /** Bumped on every change except growing strokes (`pts`); drives saving. */
    var version = 0
        private set
    /** Bumped on every change (redraw). */
    var revision = 0
        private set
    private val chunks = ChunkAssembler()
    private val undo = ArrayDeque<List<JSONObject>>()
    private val redo = ArrayDeque<List<JSONObject>>()
    /** Stroke id → last time points arrived (remote strokes still growing). */
    val hot = HashMap<String, Long>()

    val canUndo get() = undo.isNotEmpty()
    val canRedo get() = redo.isNotEmpty()

    /** Apply and publish local ops. [record] = push an undo step (pts batches are folded into the stroke's add). */
    fun local(ops: List<JSONObject>, record: Boolean = true) {
        if (ops.isEmpty()) return
        val inv = ArrayList<JSONObject>()
        for (op in ops) {
            if (record) {
                val before = doc.page(op.optString("p"))?.deepCopy()
                inv.addAll(0, WbOps.inverse(op, before, doc))
            }
            applyOne(op)
        }
        if (record && inv.isNotEmpty()) {
            undo.addLast(inv)
            while (undo.size > 100) undo.removeFirst()
            redo.clear()
        }
        publish(ops)
    }

    fun undo() = step(undo, redo)
    fun redo() = step(redo, undo)

    private fun step(from: ArrayDeque<List<JSONObject>>, to: ArrayDeque<List<JSONObject>>) {
        val ops = from.removeLastOrNull() ?: return
        val inv = ArrayList<JSONObject>()
        for (op in ops) {
            val before = doc.page(op.optString("p"))?.deepCopy()
            inv.addAll(0, WbOps.inverse(op, before, doc))
            applyOne(op)
        }
        if (inv.isNotEmpty()) to.addLast(inv)
        publish(ops)
    }

    private fun applyOne(op: JSONObject) {
        if (WbOps.apply(doc, op)) {
            revision++
            if (op.optString("k") != "pts") version++
        }
    }

    private fun publish(ops: List<JSONObject>) {
        // Large adds (images) are chunked by encode().
        send(WbCodec.encode(WbCodec.opsPacket(ops)), null)
    }

    fun snapshotPackets(): List<ByteArray> = WbCodec.encode(WbCodec.snapshot(doc))
    fun sendSnapshot(to: List<String>? = null) = send(snapshotPackets(), to)

    /**
     * One packet from the room. [sender] = participant identity (null = server
     * relay, which already checked permission and sets `by`). [holders] =
     * identities allowed to draw now. Returns true when the board changed.
     */
    fun receive(bytes: ByteArray, sender: String?, holders: Set<String>, now: Long = System.currentTimeMillis()): Boolean {
        var p = WbCodec.decode(bytes) ?: return false
        if (sender != null) {
            if (!sender.startsWith("student_")) return false // other teachers / screen identities never drive our board
            if (p.optString("t") !in setOf("ops", "chunk", "req")) return false
        }
        if (p.optString("t") == "chunk") {
            if (sender != null && p.optInt("n") > 8) return false // students only send small ink
            p = chunks.add(p, now) ?: return false
            if (p.optInt("v") != 1) return false
        }
        return when (p.optString("t")) {
            "req" -> {
                val to = p.optString("to").takeIf { it.isNotBlank() && it.length <= 128 } ?: sender
                if (to != null) sendSnapshot(listOf(to))
                false
            }
            "ops" -> {
                val by = sender ?: p.optString("by").takeIf { it.startsWith("student_") } ?: return false
                if (sender != null && by !in holders) return false
                if (sender != null && p.optString("by", by) != by) return false
                val arr = p.optJSONArray("ops") ?: return false
                var changed = false
                for (i in 0 until minOf(arr.length(), 200)) {
                    val op = arr.optJSONObject(i) ?: continue
                    if (!WbOps.studentAllowed(op, by, doc)) continue
                    if (WbOps.apply(doc, op)) {
                        changed = true
                        revision++
                        val k = op.optString("k")
                        if (k != "pts") version++
                        if (k == "pts") hot[op.optString("id")] = now
                        if (k == "add") op.optJSONObject("item")?.optString("id")?.let { hot[it] = now }
                    }
                }
                changed
            }
            else -> false
        }
    }

    /** Ids of remote strokes that grew within HOT_MS. */
    fun hotIds(now: Long = System.currentTimeMillis()): Set<String> {
        hot.entries.removeAll { now - it.value > Wb.HOT_MS }
        return hot.keys.toSet()
    }

    companion object {
        /** Base64 packets for POST /whiteboard snap, null when over the server limits (64 × 96 000 chars, 2 MB). */
        fun storable(packets: List<ByteArray>): List<String>? {
            val b64 = WbCodec.toB64(packets)
            if (b64.size > 64 || b64.any { it.length > 96_000 } || b64.sumOf { it.length } > 2_000_000) return null
            return b64
        }

        /** Saved board (local file) → doc. */
        fun restore(json: String?): Doc? = try {
            if (json.isNullOrBlank()) null else Doc.clean(JSONObject(json))
        } catch (_: Exception) {
            null
        }
    }
}
