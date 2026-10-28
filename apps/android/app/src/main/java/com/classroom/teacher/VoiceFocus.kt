package com.classroom.teacher

import kotlin.math.exp
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * Voice focus for the teacher's microphone: the same algorithm as the web
 * app's apps/web/public/audio/voice-focus-worklet.js (docs/AUDIO.md), on
 * the 10 ms frames WebRTC's capture post-processing hands over
 * (VoiceFocusProcessor).
 *
 * The teacher's level is the loudest 10% of the frames clearly above the
 * noise floor over the last ~20 s (a decaying level histogram: a cough or a
 * door slam cannot move it). Sound more than [rangeDb] under it is turned
 * down 2 dB per dB, to at most [depthDb], between sentences; one frame of
 * look-ahead (10 ms) so word onsets are not clipped, hysteresis and a hold
 * so word endings are kept. Nothing is turned down until the teacher has
 * been heard. Levels are relative, so it works for any sample scale
 * (WebRTC's float samples are in the 16-bit range).
 *
 * Pure JVM code, allocation-free per frame: unit-tested (VoiceFocusTest).
 */
class VoiceFocus(
    private val rangeDb: Double = 15.0,
    private val depthDb: Double = 24.0,
    private val holdMs: Double = 120.0,
    private val releaseMs: Double = 80.0,
) {
    @Volatile
    var enabled: Boolean = true

    /** The teacher's level, dB; NaN until heard. */
    var speech: Double = Double.NaN
        private set
    var floor: Double = Double.NaN
        private set
    var gain: Double = 1.0
        private set

    private var frameSec = 0.01
    private var holdFrames = 12
    private var release = 0.0
    private var growth = 1.0
    private var weight = 1.0
    private val hist = DoubleArray(BINS)
    private var total = 0.0
    private var hold = 0
    private var open = false

    /** The previous frame (one frame of look-ahead) and its power. */
    private var delay = FloatArray(0)
    private var delayLen = 0
    private var delayPower = 0.0

    init {
        configure(480, 48000)
    }

    /** Frame length and rate (WebRTC: 10 ms frames). Keeps what was learned. */
    fun configure(frameLen: Int, sampleRate: Int) {
        frameSec = if (sampleRate > 0 && frameLen > 0) frameLen.toDouble() / sampleRate else 0.01
        holdFrames = max(1, (holdMs / 1000 / frameSec).roundToInt())
        release = 1 - exp(-frameSec / (releaseMs / 1000))
        growth = exp(frameSec / 20.0)
        if (delay.size < frameLen) delay = FloatArray(frameLen)
    }

    private fun learn(lvl: Double) {
        val i = (lvl.roundToInt() - BIN_MIN).coerceIn(0, BINS - 1)
        hist[i] += weight
        total += weight
        weight *= growth
        if (weight > 1e200) {
            for (k in 0 until BINS) hist[k] /= weight
            total /= weight
            weight = 1.0
        }
        var acc = 0.0
        for (k in BINS - 1 downTo 0) {
            acc += hist[k]
            if (acc >= total * SPEECH_TOP) {
                speech = (k + BIN_MIN).toDouble()
                return
            }
        }
    }

    /**
     * In place: [x] (first [n] samples) is replaced by the previous frame with
     * the gain applied, ramped from the last frame's gain (no clicks).
     */
    fun process(x: FloatArray, n: Int) {
        if (n <= 0) return
        if (delay.size < n) delay = FloatArray(n)
        var e = 0.0
        for (i in 0 until n) e += x[i].toDouble() * x[i]
        val pw = e / n
        val lvl = 10 * log10(pw + 1e-12)

        if (floor.isNaN()) floor = lvl
        else if (lvl < floor) floor += (lvl - floor) * 0.2
        else floor += (lvl - floor) * 0.0005
        if (lvl > floor + 15) learn(lvl)

        // Decide on the window = the frame going out (previous) + this one.
        val win = 10 * log10((pw + delayPower) / 2 + 1e-12)
        val threshold = if (speech.isNaN()) Double.NEGATIVE_INFINITY else speech - rangeDb
        var target = 1.0
        if (win >= (if (open) threshold - 6 else threshold)) {
            open = true
            hold = holdFrames
        } else if (hold > 0) {
            hold--
        } else {
            open = false
            if (enabled) target = 10.0.pow(max(-depthDb, 2 * (win - threshold)) / 20)
        }
        val from = gain
        val to = if (target >= from) target else from + (target - from) * release

        // Swap: out = previous frame (gained), keep this frame for the next call.
        val outLen = if (delayLen == 0) n else min(n, delayLen)
        val step = (to - from) / n
        for (i in 0 until n) {
            val cur = x[i]
            val prev = if (delayLen == 0 || i >= outLen) 0f else delay[i]
            x[i] = (prev * (from + step * (i + 1))).toFloat()
            delay[i] = cur
        }
        delayLen = n
        delayPower = pw
        gain = to
    }

    companion object {
        private const val BIN_MIN = -120
        private const val BINS = 220
        private const val SPEECH_TOP = 0.1
    }
}
