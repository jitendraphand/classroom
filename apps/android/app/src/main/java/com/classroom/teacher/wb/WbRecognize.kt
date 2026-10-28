package com.classroom.teacher.wb

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Hold-to-snap shape recognition: a line-by-line port of the web app's
 * apps/web/src/lib/whiteboard/recognize.ts, so a rough shape snaps to the
 * same clean shape on every teacher app. Pure JVM code: unit-tested against
 * the web test fixtures.
 */
object WbRecognize {
    /** Hold still this long at the end of a stroke to snap it (web SNAP_HOLD_MS). */
    const val SNAP_HOLD_MS = 500L
    /** "Still" = moved less than this many page units while holding (web SNAP_STILL_PX). */
    const val SNAP_STILL_PX = 6.0

    data class Snap(val k: String, val x1: Int, val y1: Int, val x2: Int, val y2: Int)
    data class P(val x: Double, val y: Double)

    private fun dist(a: P, b: P) = hypot(a.x - b.x, a.y - b.y)

    /** JS Math.round. */
    private fun r(v: Double): Int = Math.floor(v + 0.5).toInt()

    private fun pathLength(p: List<P>): Double {
        var l = 0.0
        for (i in 1 until p.size) l += dist(p[i - 1], p[i])
        return l
    }

    /** [n] points evenly spaced along the path (web resample). */
    fun resample(p: List<P>, n: Int): List<P> {
        val l = pathLength(p)
        if (p.size < 2 || l == 0.0) return p.toList()
        val step = l / (n - 1)
        val out = ArrayList<P>(n)
        out.add(p[0])
        var acc = 0.0
        var prev = p[0]
        var i = 1
        while (i < p.size && out.size < n) {
            val cur = p[i]
            var d = dist(prev, cur)
            while (acc + d >= step && out.size < n) {
                val t = (step - acc) / d
                val q = P(prev.x + t * (cur.x - prev.x), prev.y + t * (cur.y - prev.y))
                out.add(q)
                prev = q
                d = dist(prev, cur)
                acc = 0.0
            }
            acc += d
            prev = cur
            i++
        }
        while (out.size < n) out.add(p[p.size - 1])
        return out
    }

    /** Indices of sharp turns (> 50°) along an evenly resampled closed path. */
    private fun corners(r: List<P>): List<Int> {
        val n = r.size
        val k = 4
        val turn = DoubleArray(n)
        for (i in 0 until n) {
            val a = r[(i - k + n) % n]; val b = r[i]; val c = r[(i + k) % n]
            val a1 = atan2(b.y - a.y, b.x - a.x); val a2 = atan2(c.y - b.y, c.x - b.x)
            var d = abs(a2 - a1)
            if (d > PI) d = 2 * PI - d
            turn[i] = d
        }
        val out = ArrayList<Int>()
        for (i in 0 until n) {
            if (turn[i] < 50 * PI / 180) continue
            var best = true
            var j = -k
            while (j <= k && best) {
                if (j != 0 && turn[(i + j + n) % n] > turn[i]) best = false
                j++
            }
            if (best && out.none { o -> min(abs(o - i), n - abs(o - i)) <= k }) out.add(i)
        }
        return out
    }

    /** Snap a line to 0°, 45° or 90° when it is within 6° of it. */
    private fun snapAngle(a: P, b: P): P {
        val ang = atan2(b.y - a.y, b.x - a.x)
        val len = dist(a, b)
        val step = PI / 4
        val near = Math.floor(ang / step + 0.5) * step
        if (abs(ang - near) > 6 * PI / 180) return b
        return P(r(a.x + len * cos(near)).toDouble(), r(a.y + len * sin(near)).toDouble())
    }

    /** The clean shape a free-hand stroke stands for, or null (web recognizeShape). */
    fun recognize(pts: IntArray): Snap? {
        val raw = ArrayList<P>(pts.size / 2)
        var i = 0
        while (i + 1 < pts.size) { raw.add(P(pts[i].toDouble(), pts[i + 1].toDouble())); i += 2 }
        if (raw.size < 4) return null
        var x0 = Double.POSITIVE_INFINITY; var y0 = Double.POSITIVE_INFINITY
        var x1 = Double.NEGATIVE_INFINITY; var y1 = Double.NEGATIVE_INFINITY
        for (q in raw) { x0 = min(x0, q.x); x1 = max(x1, q.x); y0 = min(y0, q.y); y1 = max(y1, q.y) }
        val w = x1 - x0; val h = y1 - y0; val diag = hypot(w, h)
        if (diag < 40) return null
        val l = pathLength(raw)
        val start = raw[0]; val end = raw[raw.size - 1]

        // Straight line: every point close to the chord, and no doubling back along it.
        val chord = dist(start, end)
        if (chord > 40 && l / chord < 1.5) {
            var dev = 0.0
            val dx = end.x - start.x; val dy = end.y - start.y
            for (q in raw) dev = max(dev, abs(dy * (q.x - start.x) - dx * (q.y - start.y)) / chord)
            if (dev < 0.06 * chord) {
                val e = snapAngle(start, end)
                return Snap("line", r(start.x), r(start.y), r(e.x), r(e.y))
            }
        }
        // Closed shapes only from here: the stroke ends near where it began.
        if (dist(start, end) > max(0.2 * diag, 30.0)) return null
        val rs = resample(raw, 64)
        val cx = (x0 + x1) / 2; val cy = (y0 + y1) / 2
        val rx = max(1.0, w / 2); val ry = max(1.0, h / 2)

        val cs = corners(rs)
        if (cs.size == 4) {
            var off = 0.0
            for (q in rs) off += minOf(abs(q.x - x0), abs(q.x - x1), abs(q.y - y0), abs(q.y - y1))
            if (off / rs.size / diag < 0.06) return Snap("rect", r(x0), r(y0), r(x1), r(y1))
        }
        if (cs.size == 3) {
            val pts3 = cs.map { rs[it] }.sortedBy { it.y }
            val apex = pts3[0]; val base = pts3.drop(1)
            val apexCentred = abs(apex.x - cx) < 0.2 * w && apex.y - y0 < 0.15 * h
            val baseLow = base.all { y1 - it.y < 0.15 * h }
            if (apexCentred && baseLow) return Snap("tri", r(x0), r(y0), r(x1), r(y1))
        }
        if (cs.size <= 2) {
            var dev = 0.0
            for (q in rs) dev += abs(hypot((q.x - cx) / rx, (q.y - cy) / ry) - 1)
            if (dev / rs.size < 0.16) {
                if (abs(rx - ry) / max(rx, ry) < 0.15) {
                    val m = (rx + ry) / 2
                    return Snap("ellipse", r(cx - m), r(cy - m), r(cx + m), r(cy + m))
                }
                return Snap("ellipse", r(x0), r(y0), r(x1), r(y1))
            }
        }
        return null
    }
}
