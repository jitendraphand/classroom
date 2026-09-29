package com.classroom.teacher

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.classroom.teacher.databinding.ActivityMainBinding
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject

/**
 * Teacher client for Android. Mobile browsers do not implement getDisplayMedia,
 * so screen share goes through MediaProjection and the LiveKit Android SDK into
 * the same room students already join on the website.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var api: ClassroomApi

    private var room: Room? = null
    private var code: String = ""
    private var micOn = false
    private var sharing = false
    private var pollJob: Job? = null
    private val seenMessageIds = linkedSetOf<String>()

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* Sharing still works if the user dismisses the notification prompt. */ }

    private val micPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) toggleMic() else showError("Microphone permission is required to speak.")
    }

    private val captureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val data = result.data
        if (result.resultCode != RESULT_OK || data == null) {
            showError("Screen share was cancelled.")
            return@registerForActivityResult
        }
        lifecycleScope.launch { publishScreen(data) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        binding.serverInput.setText(prefs.getString(KEY_SERVER, "") ?: "")
        binding.emailInput.setText(prefs.getString(KEY_EMAIL, "") ?: "")

        binding.loginButton.setOnClickListener { login() }
        binding.startButton.setOnClickListener { startClass() }
        binding.logoutButton.setOnClickListener { logout() }
        binding.admitAllButton.setOnClickListener { admitAll() }
        binding.enterButton.setOnClickListener { enterClass() }
        binding.backHomeButton.setOnClickListener { showHome() }
        binding.shareButton.setOnClickListener { requestScreenShare() }
        binding.stopShareButton.setOnClickListener { lifecycleScope.launch { stopScreenShare() } }
        binding.micButton.setOnClickListener { ensureMicThenToggle() }
        binding.muteAllButton.setOnClickListener { muteStudents(true) }
        binding.unmuteAllButton.setOnClickListener { muteStudents(false) }
        binding.sendButton.setOnClickListener { sendChat() }
        binding.endButton.setOnClickListener { confirmEnd() }
        binding.leaveButton.setOnClickListener { lifecycleScope.launch { leaveClass() } }
    }

    override fun onDestroy() {
        pollJob?.cancel()
        lifecycleScope.launch {
            try {
                room?.disconnect()
            } catch (_: Exception) {
            }
            room = null
        }
        stopService(Intent(this, ScreenShareService::class.java))
        super.onDestroy()
    }

    private fun login() {
        val server = binding.serverInput.text.toString().trim()
        val email = binding.emailInput.text.toString().trim()
        val password = binding.passwordInput.text.toString()
        if (!server.startsWith("http://") && !server.startsWith("https://")) {
            showError("Server must start with http:// or https://")
            return
        }
        api = ClassroomApi(server)
        setBusy(binding.loginButton, true)
        clearError()
        lifecycleScope.launch {
            try {
                val me = withContext(Dispatchers.IO) {
                    api.login(email, password)
                    api.me()
                }
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(KEY_SERVER, api.base)
                    .putString(KEY_EMAIL, email)
                    .apply()
                binding.helloText.text = "Signed in as ${me.optString("name", email)}"
                showHome()
            } catch (e: Exception) {
                showError(e.message ?: "Login failed")
            } finally {
                setBusy(binding.loginButton, false)
            }
        }
    }

    private fun logout() {
        pollJob?.cancel()
        if (::api.isInitialized) api.teacherCookie = null
        showOnly(binding.loginGroup)
    }

    private fun startClass() {
        val name = binding.classNameInput.text.toString().trim().ifBlank { "Class" }
        val max = binding.maxVisibleInput.text.toString().toIntOrNull() ?: 6
        setBusy(binding.startButton, true)
        clearError()
        lifecycleScope.launch {
            try {
                val created = withContext(Dispatchers.IO) { api.startClass(name, max) }
                code = created.optString("code")
                if (code.isBlank()) throw ApiException("The server did not return a room code")
                binding.codeText.text = code
                binding.joinText.text = created.optString("joinUrl").ifBlank { "Join code $code" }
                showLobby()
            } catch (e: Exception) {
                showError(e.message ?: "Could not start class")
            } finally {
                setBusy(binding.startButton, false)
            }
        }
    }

    private fun showHome() {
        pollJob?.cancel()
        showOnly(binding.homeGroup)
    }

    private fun showLobby() {
        showOnly(binding.lobbyGroup)
        startPolling(inClass = false)
    }

    private fun admitAll() {
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) { api.admitAll(code) }
                refreshLobby()
            } catch (e: Exception) {
                showError(e.message ?: "Could not admit students")
            }
        }
    }

    private fun enterClass() {
        pollJob?.cancel()
        showOnly(binding.classGroup)
        binding.shareButton.isEnabled = false
        binding.classStatus.text = "Connecting…"
        clearError()
        lifecycleScope.launch {
            try {
                val info = withContext(Dispatchers.IO) { api.token(code) }
                val url = info.optString("url")
                val token = info.optString("token")
                if (url.isBlank() || token.isBlank()) {
                    throw ApiException("Missing LiveKit address. Open the server by its LAN address, not localhost.")
                }
                val connected = LiveKit.create(applicationContext)
                room = connected
                listen(connected)
                connected.connect(url, token)
                binding.classStatus.text = "In class $code. Share screen when you are ready."
                binding.shareButton.isEnabled = true
                startPolling(inClass = true)
            } catch (e: Exception) {
                binding.classStatus.text = "Not connected"
                showError(e.message ?: "Could not join the room")
            }
        }
    }

    private fun listen(connected: Room) {
        lifecycleScope.launch {
            connected.events.collect { event ->
                if (event is RoomEvent.Disconnected) {
                    withContext(Dispatchers.Main) {
                        sharing = false
                        binding.classStatus.text = "Disconnected from the room"
                        binding.shareButton.isEnabled = false
                    }
                }
            }
        }
    }

    private fun requestScreenShare() {
        if (room == null) {
            showError("Join the class before sharing.")
            return
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        captureLauncher.launch(manager.createScreenCaptureIntent())
    }

    private suspend fun publishScreen(data: Intent) {
        val connected = room ?: return
        clearError()
        val ready = CompletableDeferred<Unit>()
        ScreenShareService.ready = ready
        ContextCompat.startForegroundService(this, Intent(this, ScreenShareService::class.java))
        val started = withTimeoutOrNull(4_000) { ready.await() }
        if (started == null) {
            showError("Could not start the screen-share service.")
            stopService(Intent(this, ScreenShareService::class.java))
            return
        }
        try {
            val ok = connected.localParticipant.setScreenShareEnabled(
                true,
                ScreenCaptureParams(mediaProjectionPermissionResultData = data),
            )
            if (!ok) throw ApiException("LiveKit did not start screen share")
            sharing = true
            binding.classStatus.text = "Sharing this device with the class"
            withContext(Dispatchers.IO) { api.stage(code, "screen") }
        } catch (e: Exception) {
            sharing = false
            stopService(Intent(this, ScreenShareService::class.java))
            showError(e.message ?: "Could not share the screen")
        }
    }

    private suspend fun stopScreenShare() {
        clearError()
        try {
            room?.localParticipant?.setScreenShareEnabled(false)
        } catch (e: Exception) {
            showError(e.message ?: "Could not stop sharing")
        }
        sharing = false
        stopService(Intent(this, ScreenShareService::class.java))
        binding.classStatus.text = "Screen share stopped"
        try {
            withContext(Dispatchers.IO) { api.stage(code, "idle") }
        } catch (_: Exception) {
        }
    }

    private fun ensureMicThenToggle() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        toggleMic()
    }

    private fun toggleMic() {
        val connected = room ?: return
        val next = !micOn
        lifecycleScope.launch {
            try {
                connected.localParticipant.setMicrophoneEnabled(next)
                micOn = next
                binding.micButton.text = if (micOn) "Turn microphone off" else "Turn microphone on"
            } catch (e: Exception) {
                showError(e.message ?: "Could not change the microphone")
            }
        }
    }

    private fun muteStudents(muted: Boolean) {
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) { api.muteAll(code, muted) }
                binding.classStatus.text = if (muted) "Students muted" else "Students can unmute"
            } catch (e: Exception) {
                showError(e.message ?: "Could not change student microphones")
            }
        }
    }

    private fun sendChat() {
        val text = binding.chatInput.text.toString().trim()
        if (text.isEmpty()) return
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) { api.sendBroadcast(code, text) }
                binding.chatInput.setText("")
                refreshChat()
            } catch (e: Exception) {
                showError(e.message ?: "Could not send")
            }
        }
    }

    private fun confirmEnd() {
        AlertDialog.Builder(this)
            .setTitle("End class for everyone?")
            .setPositiveButton("End class") { _, _ ->
                lifecycleScope.launch { endClass() }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private suspend fun endClass() {
        try {
            if (sharing) stopScreenShare()
            withContext(Dispatchers.IO) { api.end(code) }
        } catch (e: Exception) {
            showError(e.message ?: "Could not end class")
        }
        disconnectRoom()
        showHome()
    }

    private suspend fun leaveClass() {
        try {
            if (sharing) stopScreenShare()
            withContext(Dispatchers.IO) { api.leave(code) }
        } catch (_: Exception) {
        }
        disconnectRoom()
        showHome()
    }

    private suspend fun disconnectRoom() {
        pollJob?.cancel()
        try {
            room?.disconnect()
        } catch (_: Exception) {
        }
        room = null
        micOn = false
        sharing = false
    }

    private fun startPolling(inClass: Boolean) {
        pollJob?.cancel()
        pollJob = lifecycleScope.launch {
            while (isActive) {
                try {
                    if (inClass) {
                        val state = withContext(Dispatchers.IO) { api.state(code) }
                        if (state.optString("status") == "ENDED" || state.optBoolean("ended")) {
                            binding.classStatus.text = "Class ended"
                            disconnectRoom()
                            showHome()
                            return@launch
                        }
                        refreshChat()
                    } else {
                        refreshLobby()
                    }
                } catch (e: Exception) {
                    showError(e.message ?: "Lost contact with the server")
                }
                delay(2000)
            }
        }
    }

    private suspend fun refreshLobby() {
        val state = withContext(Dispatchers.IO) { api.state(code) }
        val waiting = state.optJSONArray("waiting") ?: JSONArray()
        val admitted = (state.optJSONArray("admitted") ?: JSONArray()).length()
        withContext(Dispatchers.Main) {
            binding.waitingList.removeAllViews()
            if (waiting.length() == 0) {
                binding.waitingList.addView(note("No one is waiting. $admitted already admitted."))
            }
            for (i in 0 until waiting.length()) {
                val person = waiting.getJSONObject(i)
                val id = person.optString("id")
                val name = person.optString("displayName", "Student")
                val row = LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.HORIZONTAL
                }
                val label = note(name).apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f) }
                val admit = Button(this@MainActivity).apply {
                    text = "Admit"
                    setOnClickListener {
                        lifecycleScope.launch {
                            try {
                                withContext(Dispatchers.IO) { api.admit(code, id) }
                                refreshLobby()
                            } catch (e: Exception) {
                                showError(e.message ?: "Could not admit $name")
                            }
                        }
                    }
                }
                row.addView(label)
                row.addView(admit)
                binding.waitingList.addView(row)
            }
        }
    }

    private suspend fun refreshChat() {
        val payload = withContext(Dispatchers.IO) { api.messages(code) }
        val messages = payload.optJSONArray("messages") ?: JSONArray()
        val lines = buildString {
            for (i in 0 until messages.length()) {
                val message = messages.getJSONObject(i)
                val id = message.optString("id")
                if (id.isNotBlank()) seenMessageIds.add(id)
                val who = message.optString("senderName", "Someone")
                val body = message.optString("body")
                append(who).append(": ").append(body).append('\n')
            }
        }
        binding.chatLog.text = lines.ifBlank { "No messages yet." }
    }

    private fun note(text: String) = android.widget.TextView(this).apply {
        this.text = text
        setTextColor(0xFFE2E8F0L.toInt())
        textSize = 16f
        setPadding(0, 12, 0, 12)
    }

    private fun showOnly(group: View) {
        binding.loginGroup.visibility = View.GONE
        binding.homeGroup.visibility = View.GONE
        binding.lobbyGroup.visibility = View.GONE
        binding.classGroup.visibility = View.GONE
        group.visibility = View.VISIBLE
        clearError()
    }

    private fun showError(message: String) {
        binding.errorText.text = message
    }

    private fun clearError() {
        binding.errorText.text = ""
    }

    private fun setBusy(button: Button, busy: Boolean) {
        button.isEnabled = !busy
    }

    companion object {
        private const val PREFS = "classroom_teacher"
        private const val KEY_SERVER = "server"
        private const val KEY_EMAIL = "email"
    }
}
