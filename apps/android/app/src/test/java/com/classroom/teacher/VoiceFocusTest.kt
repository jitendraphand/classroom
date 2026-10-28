package com.classroom.teacher

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.log10
import kotlin.math.sin
import kotlin.math.sqrt

/** Same cases as the web voice-focus tests (apps/web/tests/voice.test.ts), on 10 ms frames. */
class VoiceFocusTest {
    private val n = 480
    private var phase = 0L

    /** One 10 ms frame of a tone at [db] dB RMS, in WebRTC's 16-bit float scale when [s16]. */
    private fun frame(db: Double, f: Double = 220.0, s16: Boolean = true): FloatArray {
        val a = sqrt(2.0) * Math.pow(10.0, db / 20) * (if (s16) 32768.0 else 1.0)
        val x = FloatArray(n) { i -> (a * sin(2 * PI * f * (phase + i) / 48000)).toFloat() }
        phase += n
        return x
    }

    private fun db(x: FloatArray, s16: Boolean = true): Double {
        var e = 0.0
        for (v in x) e += v.toDouble() * v
        val ref = if (s16) 32768.0 * 32768.0 else 1.0
        return 10 * log10(e / x.size / ref + 1e-12)
    }

    private fun run(f: VoiceFocus, frames: Int, db: Double, s16: Boolean = true, tone: Double = 220.0): List<FloatArray> =
        List(frames) { frame(db, tone, s16).also { f.process(it, n) } }

    @Test
    fun passesSpeechUntouchedOneFrameLate() {
        val f = VoiceFocus()
        run(f, 20, -70.0)
        val inputs = List(50) { frame(-20.0) }
        val outs = inputs.map { it.copyOf().also { x -> f.process(x, n) } }
        for (k in 1 until 50) assertArrayEquals(inputs[k - 1], outs[k], 1e-2f)
    }

    @Test
    fun learnsTheLevelAndTurnsDownFarSound() {
        val f = VoiceFocus()
        assertTrue(f.speech.isNaN())
        run(f, 30, -70.0)
        run(f, 100, -18.0)
        // Levels are in the samples' own scale: 16-bit full scale is +90.3 dB.
        val dbfs = f.speech - 20 * log10(32768.0)
        assertTrue("speech $dbfs dBFS", dbfs in -20.0..-16.0)
        val far = run(f, 100, -48.0, tone = 300.0)
        val g = far.takeLast(10).map { db(it) + 48 }.average()
        assertTrue("far voice attenuated ($g dB)", g < -20)
    }

    @Test
    fun scaleInvariant() {
        // Samples in 0..1 instead of the 16-bit scale: same decisions.
        val f = VoiceFocus()
        run(f, 30, -70.0, s16 = false)
        run(f, 100, -18.0, s16 = false)
        val far = run(f, 100, -48.0, s16 = false, tone = 300.0)
        assertTrue(far.takeLast(10).map { db(it, s16 = false) + 48 }.average() < -20)
    }

    @Test
    fun aBangDoesNotRaiseTheLevelAndSpeechAfterItPasses() {
        val f = VoiceFocus()
        run(f, 30, -70.0)
        repeat(8) {
            run(f, 80, -24.0)
            run(f, 20, -70.0)
        }
        val before = f.speech
        run(f, 10, -2.0)
        assertEquals(before, f.speech, 1.0)
        val after = run(f, 60, -26.0)
        assertTrue(after.takeLast(20).all { db(it) > -27.5 })
    }

    @Test
    fun neverTurnsDownWhenOffOrBeforeTheTeacherWasHeard() {
        val off = VoiceFocus().apply { enabled = false }
        run(off, 30, -70.0)
        run(off, 100, -18.0)
        val quiet = run(off, 100, -60.0)
        assertEquals(-60.0, db(quiet.last()), 0.6)
        val fresh = VoiceFocus()
        val all = run(fresh, 100, -20.0)
        assertTrue(fresh.speech.isNaN())
        assertEquals(-20.0, db(all.last()), 0.6)
        val silent = VoiceFocus()
        val z = List(20) { FloatArray(n).also { x -> silent.process(x, n) } }
        assertTrue(z.all { x -> x.all { it.isFinite() } })
    }

    @Test
    fun constantsMatchTheWebWorklet() {
        var dir: java.io.File? = java.io.File("").absoluteFile
        var web: java.io.File? = null
        repeat(5) {
            val f = java.io.File(dir, "apps/web/public/audio/voice-focus-worklet.js")
            if (web == null && f.exists()) web = f
            dir = dir?.parentFile
        }
        org.junit.Assume.assumeTrue("web sources not found next to the Android app", web != null)
        val js = web!!.readText()
        val kt = java.io.File(VoiceFocusSource.path()).takeIf { it.exists() }?.readText()
        org.junit.Assume.assumeTrue("Kotlin source not found", kt != null)
        for ((jsDecl, ktDecl) in listOf(
            "const SPEECH_TOP = 0.1;" to "private const val SPEECH_TOP = 0.1",
            "const BIN_MIN = -120;" to "private const val BIN_MIN = -120",
            "const BINS = 220;" to "private const val BINS = 220",
            "this.range = opts.range ?? 15;" to "private val rangeDb: Double = 15.0",
            "(opts.holdMs ?? 120)" to "private val holdMs: Double = 120.0",
            "(opts.releaseMs ?? 80)" to "private val releaseMs: Double = 80.0",
            "Math.exp(blockSec / 20)" to "exp(frameSec / 20.0)",
            "if (lvl > this.floor + 15) this.learn(lvl);" to "if (lvl > floor + 15) learn(lvl)",
            "win >= (this.open ? threshold - 6 : threshold)" to "win >= (if (open) threshold - 6 else threshold)",
            "2 * (win - threshold)" to "2 * (win - threshold)",
        )) {
            assertTrue("web worklet changed: $jsDecl", js.contains(jsDecl))
            assertTrue("VoiceFocus.kt changed: $ktDecl", kt!!.contains(ktDecl))
        }
    }
}

/** Where VoiceFocus.kt is, from the module or the repository root. */
private object VoiceFocusSource {
    fun path(): String {
        var dir: java.io.File? = java.io.File("").absoluteFile
        repeat(5) {
            for (rel in listOf("apps/android/app/src/main/java/com/classroom/teacher/VoiceFocus.kt", "src/main/java/com/classroom/teacher/VoiceFocus.kt", "app/src/main/java/com/classroom/teacher/VoiceFocus.kt")) {
                val f = java.io.File(dir, rel)
                if (f.exists()) return f.path
            }
            dir = dir?.parentFile
        }
        return ""
    }
}
