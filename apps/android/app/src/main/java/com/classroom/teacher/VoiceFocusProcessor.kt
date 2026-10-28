package com.classroom.teacher

import io.livekit.android.audio.AudioProcessorInterface
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Runs [VoiceFocus] on the teacher's microphone as LiveKit's capture
 * post-processor: after the phone's echo cancellation and noise
 * suppression and WebRTC's own, before encoding. WebRTC calls it every
 * 10 ms on its audio thread with channel 0 of the frame as float samples
 * (webrtc-sdk ExternalAudioProcessor: audio->channels()[0], a direct
 * buffer in native byte order). No allocation per frame.
 */
class VoiceFocusProcessor : AudioProcessorInterface {
    val focus = VoiceFocus()

    @Volatile
    private var sampleRate = 48000
    private var scratch = FloatArray(480)

    /** Long-press on the mic toggles it (saved in the app's preferences). */
    var on: Boolean
        get() = focus.enabled
        set(value) {
            focus.enabled = value
        }

    override fun isEnabled(): Boolean = true

    override fun getName(): String = "classroom-voice-focus"

    override fun initializeAudioProcessing(sampleRateHz: Int, numChannels: Int) {
        sampleRate = sampleRateHz
        focus.configure(sampleRateHz / 100, sampleRateHz)
    }

    override fun resetAudioProcessing(newRate: Int) {
        sampleRate = newRate
        focus.configure(newRate / 100, newRate)
    }

    override fun processAudio(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
        val buf = buffer.order(ByteOrder.nativeOrder())
        val n = minOf(numFrames, buf.capacity() / 4)
        if (n <= 0) return
        if (scratch.size < n) {
            scratch = FloatArray(n)
            focus.configure(n, n * 100)
        }
        for (i in 0 until n) scratch[i] = buf.getFloat(i * 4)
        focus.process(scratch, n)
        for (i in 0 until n) buf.putFloat(i * 4, scratch[i])
    }
}
