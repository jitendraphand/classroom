package com.classroom.teacher

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationManager
import android.content.ComponentCallbacks
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Point
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.ContextThemeWrapper
import android.view.WindowManager
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import com.classroom.teacher.databinding.ActivityMainBinding
import io.livekit.android.LiveKit
import io.livekit.android.events.DisconnectReason
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.participant.VideoTrackPublishOptions
import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.CustomVideoPreset
import io.livekit.android.room.track.LocalScreencastVideoTrack
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray

/**
 * Teacher client for Android. Mobile browsers do not implement getDisplayMedia,
 * so screen share goes through MediaProjection and the LiveKit Android SDK into
 * the same room students join on the website.
 *
 * Screens: sign in → classes (rejoin the live class, start today's timetabled
 * class, or an extra ad-hoc class) → in class (share screen, microphone,
 * waiting students + Admit all, chat, leave / end) → "continued on another
 * device" when the same account takes the class elsewhere.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private var api: ClassroomApi? = null

    private var room: Room? = null
    private var roomJob: Job? = null
    private var code: String = ""
    private var classLabel: String = ""
    private var micOn = false
    private var sharing = false
    private var pollJob: Job? = null
    private var knownWaiting = 0
    private var pendingCapture = false
    /** Set while this device deliberately leaves, so the Disconnected event is not shown as an error. */
    private var leaving = false
    private var grades: List<GradeChoice> = emptyList()

    // Camera
    private var cameraOn = false
    private var cameraTrack: LocalVideoTrack? = null
    private var cameraPosition = CameraPosition.FRONT
    private var previewRenderer: TextureViewRenderer? = null

    // Screen share (published by hand so frames pass through the mask processor)
    private var screenTrack: LocalScreencastVideoTrack? = null
    private val maskProcessor = ScreenMaskProcessor()

    // Floating toolbar
    private var toolbar: FloatingToolbar? = null
    private var toolbarWanted = true
    private var overlayExplained = false
    private var pendingShareAfterOverlay = false
    private var appVisible = false
    private var toolbarExpanded = false
    private var waitingList: List<Pair<String, String>> = emptyList()
    private var handsRaised = 0
    private var focusAlerts = 0
    private var recentChat: List<String> = emptyList()
    private var chatIds: List<String> = emptyList()
    private var lastSeenChatId: String? = null
    private var unreadChat = 0

    /** Display rotations / size changes reach the application even while this activity is in the background. */
    private val displayCallbacks = object : ComponentCallbacks {
        override fun onConfigurationChanged(newConfig: Configuration) {
            updateDisplaySize()
            toolbar?.keepOnScreen()
        }

        @Deprecated("Deprecated in Java")
        override fun onLowMemory() = Unit
    }

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        if (pendingCapture) {
            pendingCapture = false
            launchCapture()
        }
    }

    private val micPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) toggleMic() else showError("Microphone permission is required to speak.")
    }

    private val cameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) toggleCamera() else showError("Camera permission is required to show your video.")
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
        // targetSdk 35 draws edge to edge on Android 15: keep content clear of
        // the status / navigation bars and display cutouts.
        ViewCompat.setOnApplyWindowInsetsListener(binding.scroll) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        applyResponsiveLayout()

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        binding.serverInput.setText(prefs.getString(KEY_SERVER, null) ?: ClassroomApi.DEFAULT_SERVER)
        binding.emailInput.setText(prefs.getString(KEY_EMAIL, "") ?: "")

        binding.loginButton.setOnClickListener { login() }
        binding.logoutButton.setOnClickListener { logout() }
        binding.refreshButton.setOnClickListener { loadHome() }
        binding.rejoinButton.setOnClickListener { binding.rejoinButton.tag?.toString()?.let { enterClass(it) } }
        binding.adhocButton.setOnClickListener { startAdHoc() }
        binding.admitAllButton.setOnClickListener { admitAll() }
        binding.shareButton.setOnClickListener { requestScreenShare() }
        binding.stopShareButton.setOnClickListener { lifecycleScope.launch { stopScreenShare() } }
        binding.micButton.setOnClickListener { ensureMicThenToggle() }
        binding.cameraButton.setOnClickListener { ensureCameraThenToggle() }
        binding.switchCameraButton.setOnClickListener { switchCamera() }
        binding.overlayButton.setOnClickListener { onOverlayButton() }
        binding.muteAllButton.setOnClickListener { muteStudents(true) }
        binding.unmuteAllButton.setOnClickListener { muteStudents(false) }
        binding.sendButton.setOnClickListener { sendChat() }
        binding.endButton.setOnClickListener { confirmEnd() }
        binding.leaveButton.setOnClickListener { lifecycleScope.launch { leaveClass() } }
        binding.useHereButton.setOnClickListener { enterClass(code) }
        binding.handoffHomeButton.setOnClickListener { loadHome() }
        binding.gradeSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) = renderDivisions()
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }
        ShareStopReceiver.onStopRequested = { lifecycleScope.launch { stopScreenShare() } }
        application.registerComponentCallbacks(displayCallbacks)
        updateDisplaySize()
        renderOverlayButton()

        // Resume a saved session (the server may have replaced it meanwhile).
        val savedCookie = prefs.getString(KEY_COOKIE, null)
        val savedServer = prefs.getString(KEY_SERVER, null)
        if (savedCookie != null && savedServer != null) {
            api = ClassroomApi(savedServer).also {
                it.teacherCookie = savedCookie
                it.onCookieChange = ::persistCookie
            }
            binding.helloText.text = prefs.getString(KEY_NAME, null)?.let { "Signed in as $it" } ?: ""
            loadHome()
        } else {
            showOnly(binding.loginGroup)
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyResponsiveLayout()
        updateDisplaySize()
    }

    override fun onStart() {
        super.onStart()
        appVisible = true
        updateToolbar()
    }

    override fun onStop() {
        appVisible = false
        updateToolbar()
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        getSystemService(NotificationManager::class.java).cancel(Notifications.WAITING_ID)
        markChatSeen()
        renderOverlayButton()
        if (pendingShareAfterOverlay) {
            // Back from the "Display over other apps" settings page.
            pendingShareAfterOverlay = false
            if (room != null && !sharing) proceedToCapture()
        }
        updateToolbar()
    }

    override fun onDestroy() {
        pollJob?.cancel()
        ShareStopReceiver.onStopRequested = null
        application.unregisterComponentCallbacks(displayCallbacks)
        toolbar?.hide()
        toolbar = null
        detachPreview()
        releaseLocalVideo(unpublish = false)
        room?.disconnect()
        room = null
        stopService(Intent(this, ClassAudioService::class.java))
        super.onDestroy()
    }

    /**
     * Phones (portrait): one column, full width. Wide windows (tablets,
     * landscape phones, split screen ≥ 720dp): content capped and centred, and
     * in class the controls and chat sit side by side.
     */
    private fun applyResponsiveLayout() {
        val cfg = resources.configuration
        val density = resources.displayMetrics.density
        val widthDp = cfg.screenWidthDp
        val maxDp = when {
            widthDp >= 1000 -> 960
            widthDp >= 600 -> 720
            else -> widthDp
        }
        binding.content.layoutParams = binding.content.layoutParams.apply {
            width = if (widthDp > maxDp) (maxDp * density).toInt() else ViewGroup.LayoutParams.MATCH_PARENT
        }
        val wide = widthDp >= 720
        binding.classColumns.orientation = if (wide) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        val gap = (16 * density).toInt()
        binding.controlsColumn.layoutParams = LinearLayout.LayoutParams(
            if (wide) 0 else ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            if (wide) 1f else 0f,
        )
        binding.chatColumn.layoutParams = LinearLayout.LayoutParams(
            if (wide) 0 else ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            if (wide) 1f else 0f,
        ).apply { if (wide) marginStart = gap }
        // Short landscape phones: drop the subtitle to keep the controls visible.
        binding.appSubtitle.visibility = if (cfg.screenHeightDp < 480) View.GONE else View.VISIBLE
    }

    // ---- Sign in / classes ------------------------------------------------

    private fun login() {
        val server = binding.serverInput.text.toString().trim()
        val email = binding.emailInput.text.toString().trim()
        val password = binding.passwordInput.text.toString()
        if (!server.startsWith("http://") && !server.startsWith("https://")) {
            showError("Server must start with http:// or https://")
            return
        }
        if (email.isBlank() || password.isBlank()) {
            showError("Enter your email and password.")
            return
        }
        val client = ClassroomApi(server)
        binding.loginButton.isEnabled = false
        clearError()
        lifecycleScope.launch {
            try {
                val me = withContext(Dispatchers.IO) { client.login(email, password) }
                api = client
                client.onCookieChange = ::persistCookie
                val name = me.optString("name", email)
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(KEY_SERVER, client.base)
                    .putString(KEY_EMAIL, email)
                    .putString(KEY_NAME, name)
                    .putString(KEY_COOKIE, client.teacherCookie)
                    .apply()
                binding.passwordInput.setText("")
                binding.helloText.text = "Signed in as $name"
                loadHome()
            } catch (e: Exception) {
                showError(e.message ?: "Sign-in failed")
            } finally {
                binding.loginButton.isEnabled = true
            }
        }
    }

    private fun logout() {
        pollJob?.cancel()
        val client = api
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) { client?.logout() }
            } catch (_: Exception) {
            }
        }
        forgetSession()
        showOnly(binding.loginGroup)
    }

    private fun persistCookie(cookie: String?) {
        val e = getSharedPreferences(PREFS, MODE_PRIVATE).edit()
        if (cookie == null) e.remove(KEY_COOKIE) else e.putString(KEY_COOKIE, cookie)
        e.apply()
    }

    private fun forgetSession() {
        api?.teacherCookie = null
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_COOKIE).apply()
    }

    /** The server ended this device's session (another sign-in, admin, expiry). */
    private fun sessionEnded(e: SessionEndedException) {
        lifecycleScope.launch {
            disconnectRoom()
            forgetSession()
            showOnly(binding.loginGroup)
            showError(e.message ?: "Signed out")
        }
    }

    private fun loadHome() {
        val client = api ?: return showOnly(binding.loginGroup)
        pollJob?.cancel()
        knownWaiting = 0
        showOnly(binding.homeGroup)
        binding.todayList.removeAllViews()
        binding.todayList.addView(note("Loading…"))
        lifecycleScope.launch {
            try {
                val s = withContext(Dispatchers.IO) { client.schedule() }
                renderHome(s)
            } catch (e: SessionEndedException) {
                sessionEnded(e)
            } catch (e: Exception) {
                binding.todayList.removeAllViews()
                showError(e.message ?: "Could not load your classes")
            }
        }
    }

    private fun renderHome(s: Schedule) {
        if (s.activeCode != null) {
            binding.activeCard.visibility = View.VISIBLE
            binding.activeText.text = "Live now: ${s.activeLabel?.ifBlank { null } ?: "your class"} (${s.activeCode})"
            binding.rejoinButton.tag = s.activeCode
        } else {
            binding.activeCard.visibility = View.GONE
        }
        binding.todayList.removeAllViews()
        if (s.today.isEmpty()) binding.todayList.addView(note("No timetabled classes today."))
        for (c in s.today) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
            }
            row.addView(note("${c.timeLabel}  ${c.subject} · ${c.audience}").apply {
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            if (c.canStart || c.live) {
                row.addView(Button(this).apply {
                    text = if (c.live) "Rejoin" else "Start"
                    setOnClickListener { startScheduled(c, this) }
                })
            }
            binding.todayList.addView(row)
        }
        grades = s.grades
        val hasGrades = grades.isNotEmpty()
        binding.adhocCard.visibility = if (hasGrades) View.VISIBLE else View.GONE
        binding.noGradesText.visibility = if (hasGrades) View.GONE else View.VISIBLE
        binding.gradeSpinner.adapter = spinnerAdapter(grades.map { "Grade ${it.label}" })
        renderDivisions()
    }

    private fun spinnerAdapter(items: List<String>) =
        ArrayAdapter(this, R.layout.spinner_item, items).apply { setDropDownViewResource(R.layout.spinner_dropdown_item) }

    private fun divisionOptions(): List<Pair<String?, String>> {
        val g = grades.getOrNull(binding.gradeSpinner.selectedItemPosition) ?: return emptyList()
        val list = ArrayList<Pair<String?, String>>()
        if (g.allowAll) list.add(null to "All divisions")
        g.divisions.forEach { (name, label) -> list.add(name to "Division $label") }
        return list
    }

    private fun renderDivisions() {
        binding.divisionSpinner.adapter = spinnerAdapter(divisionOptions().map { it.second })
    }

    private fun startScheduled(c: ClassChoice, button: Button) {
        val client = api ?: return
        button.isEnabled = false
        lifecycleScope.launch {
            try {
                val res = withContext(Dispatchers.IO) { client.startScheduled(c.key) }
                enterClass(res.optString("code"), "${c.subject} · ${c.audience}")
            } catch (e: SessionEndedException) {
                sessionEnded(e)
            } catch (e: Exception) {
                showError(e.message ?: "Could not start the class")
            } finally {
                button.isEnabled = true
            }
        }
    }

    private fun startAdHoc() {
        val client = api ?: return
        val g = grades.getOrNull(binding.gradeSpinner.selectedItemPosition) ?: return
        val division = divisionOptions().getOrNull(binding.divisionSpinner.selectedItemPosition)?.first
        val subject = binding.subjectInput.text.toString().trim()
        binding.adhocButton.isEnabled = false
        clearError()
        lifecycleScope.launch {
            try {
                val res = withContext(Dispatchers.IO) { client.startAdHoc(g.grade, division, subject) }
                enterClass(res.optString("code"), res.optString("name"))
            } catch (e: SessionEndedException) {
                sessionEnded(e)
            } catch (e: Exception) {
                showError(e.message ?: "Could not start the class")
            } finally {
                binding.adhocButton.isEnabled = true
            }
        }
    }

    // ---- In class ---------------------------------------------------------

    private fun enterClass(roomCode: String, label: String = classLabel) {
        val client = api ?: return
        if (roomCode.isBlank()) return showError("The server did not return a class code")
        pollJob?.cancel()
        code = roomCode.uppercase()
        classLabel = label
        showOnly(binding.classGroup)
        binding.classTitle.text = if (label.isNotBlank()) "$label · $code" else "Class $code"
        binding.shareButton.isEnabled = false
        binding.micButton.isEnabled = false
        binding.cameraButton.isEnabled = false
        binding.classStatus.text = "Connecting…"
        renderShareButtons()
        lifecycleScope.launch {
            try {
                disconnectRoom()
                val info = withContext(Dispatchers.IO) { client.token(code) }
                val url = info.optString("url")
                val token = info.optString("token")
                if (url.isBlank() || token.isBlank()) throw ApiException("The server did not return a media address.")
                val connected = LiveKit.create(applicationContext)
                room = connected
                leaving = false
                listen(connected)
                connected.connect(url, token)
                binding.classStatus.text = "In class. Students join from the school app. Sharing keeps going when you switch apps."
                binding.shareButton.isEnabled = true
                binding.micButton.isEnabled = true
                binding.cameraButton.isEnabled = true
                updateToolbar()
                if (needsNotificationPermission()) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                startPolling()
            } catch (e: SessionEndedException) {
                sessionEnded(e)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                binding.classStatus.text = "Not connected"
                if ((e as? ApiException)?.status == 410) {
                    showError("This class has ended.")
                    loadHome()
                } else {
                    showError(e.message ?: "Could not join the class")
                }
            }
        }
    }

    private fun listen(connected: Room) {
        roomJob?.cancel()
        roomJob = lifecycleScope.launch {
            connected.events.collect { event ->
                if (event is RoomEvent.Disconnected && connected === room) onDisconnected(event.reason)
            }
        }
    }

    private fun onDisconnected(reason: DisconnectReason?) {
        if (leaving || reason == DisconnectReason.CLIENT_INITIATED) return
        lifecycleScope.launch {
            room = null
            sharing = false
            releaseLocalVideo(unpublish = false)
            setMic(false)
            pollJob?.cancel()
            renderShareButtons()
            updateToolbar()
            when (reason) {
                // Same account opened the class elsewhere (web tab / other phone).
                DisconnectReason.DUPLICATE_IDENTITY -> showHandoff(
                    "Class continued on another device",
                    "This class was opened with your account on another device or tab, so this one was disconnected. The class itself carries on there.",
                )
                DisconnectReason.ROOM_DELETED, DisconnectReason.ROOM_CLOSED -> {
                    showError("The class has ended.")
                    loadHome()
                }
                else -> {
                    // Removed by the server: a newer sign-in replaces this
                    // session, or the class ended. Ask the server which.
                    try {
                        val state = withContext(Dispatchers.IO) { api?.state(code) }
                        if (state == null || state.optBoolean("ended") || state.optString("status") == "ENDED") {
                            showError("The class has ended.")
                            loadHome()
                        } else {
                            showHandoff("Disconnected from the class", "The connection to the class was lost.")
                        }
                    } catch (e: SessionEndedException) {
                        sessionEnded(e)
                    } catch (e: Exception) {
                        if ((e as? ApiException)?.status == 410) {
                            showError("The class has ended.")
                            loadHome()
                        } else {
                            showHandoff("Disconnected from the class", e.message ?: "The connection to the class was lost.")
                        }
                    }
                }
            }
        }
    }

    /**
     * The SFU link can drop without a Disconnected event reaching us while the
     * SDK retries (slow device, network change). Show it, and after a lasting
     * DISCONNECTED state rejoin with a fresh token.
     */
    private var disconnectedPolls = 0

    private fun renderConnection() {
        val r = room ?: return
        when (r.state) {
            Room.State.CONNECTED -> {
                disconnectedPolls = 0
                if (binding.classStatus.text.startsWith("Reconnecting")) {
                    binding.classStatus.text = if (sharing) "Sharing this device's screen with the class" else "In class."
                }
            }
            Room.State.RECONNECTING, Room.State.CONNECTING -> binding.classStatus.text = "Reconnecting to the class…"
            Room.State.DISCONNECTED -> {
                binding.classStatus.text = "Reconnecting to the class…"
                if (++disconnectedPolls >= 3) {
                    disconnectedPolls = 0
                    enterClass(code)
                }
            }
        }
    }

    private fun isConnected(): Boolean {
        if (room?.state == Room.State.CONNECTED) return true
        showError("Not connected to the class yet. Wait a moment and try again.")
        return false
    }

    private fun showHandoff(title: String, text: String) {
        showOnly(binding.handoffGroup)
        binding.handoffTitle.text = title
        binding.handoffText.text = text
    }

    private fun renderShareButtons() {
        binding.shareButton.visibility = if (sharing) View.GONE else View.VISIBLE
        binding.stopShareButton.visibility = if (sharing) View.VISIBLE else View.GONE
    }

    private fun requestScreenShare() {
        if (room == null) return showError("Join the class before sharing.")
        if (!isConnected()) return
        if (needsNotificationPermission()) {
            pendingCapture = true
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        proceedToCapture()
    }

    /** Offers the floating toolbar once per run before the first share, then starts the capture consent. */
    private fun proceedToCapture() {
        if (toolbarWanted && !Settings.canDrawOverlays(this) && !overlayExplained) {
            overlayExplained = true
            AlertDialog.Builder(this)
                .setTitle("Show class controls over other apps?")
                .setMessage(
                    "While you share your screen, a small floating button can show new chat messages, raised hands " +
                        "and waiting students, and lets you admit, mute, reply or stop sharing without coming back here.\n\n" +
                        "Android needs the \"Display over other apps\" permission for this. The button is blacked out " +
                        "of what students see.\n\nWithout it, sharing still works: use the notification or come back to this app.",
                )
                .setPositiveButton("Allow") { _, _ ->
                    pendingShareAfterOverlay = true
                    openOverlaySettings()
                }
                .setNegativeButton("Not now") { _, _ -> launchCapture() }
                .setOnCancelListener { launchCapture() }
                .show()
            return
        }
        launchCapture()
    }

    private fun openOverlaySettings() {
        try {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            pendingShareAfterOverlay = false
            showError("Could not open the \"Display over other apps\" setting on this device.")
        }
    }

    private fun needsNotificationPermission(): Boolean =
        Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

    private fun launchCapture() {
        val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        captureLauncher.launch(manager.createScreenCaptureIntent())
    }

    /**
     * The consent result is used exactly once (Android 14+ rejects reuse).
     * Same steps as LiveKit's setScreenShareEnabled (mediaProjection
     * foreground service first, then capture, then publish), done by hand so
     * every frame passes through [maskProcessor], which blacks out the
     * floating toolbar before encoding. The capture keeps the display's aspect
     * ratio (long side ≤ 1920) so toolbar coordinates map 1:1.
     */
    private suspend fun publishScreen(data: Intent) {
        val connected = room ?: return
        clearError()
        var track: LocalScreencastVideoTrack? = null
        try {
            updateDisplaySize()
            val (dw, dh) = maskProcessor.displaySize
            val (cw, ch) = MaskMath.captureSize(dw, dh)
            track = connected.localParticipant.createScreencastTrack(
                "screen",
                data,
                LocalVideoTrackOptions(true, null, CameraPosition.FRONT, VideoCaptureParameter(cw, ch, 15, true)),
                maskProcessor,
            ) { lifecycleScope.launch { onShareStoppedBySystem() } }
            track.startForegroundService(Notifications.SHARE_ID, Notifications.screenShare(this))
            track.startCapture()
            val ok = connected.localParticipant.publishVideoTrack(
                track,
                VideoTrackPublishOptions(
                    name = "screen",
                    videoEncoding = VideoEncoding(1_500_000, 15),
                    simulcast = false,
                    source = Track.Source.SCREEN_SHARE,
                ),
            )
            if (!ok) throw ApiException("Screen share did not start (state: ${connected.state.name.lowercase()})")
            screenTrack = track
            sharing = true
            renderShareButtons()
            updateToolbar()
            binding.classStatus.text = "Sharing this device's screen with the class"
            withContext(Dispatchers.IO) { api?.stage(code, "screen") }
        } catch (e: SessionEndedException) {
            sessionEnded(e)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (screenTrack == null && track != null) disposeScreenTrack(track, connected, unpublish = true)
            sharing = false
            renderShareButtons()
            updateToolbar()
            showError(e.message ?: "Could not share the screen")
        }
    }

    private fun disposeScreenTrack(track: LocalScreencastVideoTrack, r: Room?, unpublish: Boolean) {
        if (unpublish) {
            try {
                r?.localParticipant?.unpublishTrack(track, true)
            } catch (e: Exception) {
                android.util.Log.w(TAG, "unpublish screen", e)
            }
        }
        try { track.stopCapture() } catch (_: Exception) {}
        try { track.stop() } catch (_: Exception) {}
        try { track.dispose() } catch (_: Exception) {}
    }

    /** The user stopped the capture from the system UI (status-bar chip / cast tile). */
    private suspend fun onShareStoppedBySystem() {
        if (!sharing) return
        stopScreenShare()
    }

    private suspend fun stopScreenShare() {
        clearError()
        screenTrack?.let {
            screenTrack = null
            disposeScreenTrack(it, room, unpublish = true)
        }
        val was = sharing
        sharing = false
        renderShareButtons()
        updateToolbar()
        if (room != null) binding.classStatus.text = "Screen share stopped"
        if (was) {
            try {
                withContext(Dispatchers.IO) { api?.stage(code, "idle") }
            } catch (_: Exception) {
            }
        }
    }

    private fun ensureMicThenToggle() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        toggleMic()
    }

    private fun toggleMic() {
        val connected = room ?: return
        if (!isConnected()) return
        val next = !micOn
        lifecycleScope.launch {
            try {
                connected.localParticipant.setMicrophoneEnabled(next)
                setMic(next)
            } catch (e: Exception) {
                showError(e.message ?: "Could not change the microphone")
            }
        }
    }

    private fun setMic(on: Boolean) {
        micOn = on
        binding.micButton.text = if (on) "Turn microphone off" else "Turn microphone on"
        updateMediaService()
        renderToolbar()
    }

    /** One foreground service (types microphone | camera) keeps whatever is on running in the background. */
    private fun updateMediaService() {
        val svc = Intent(this, ClassAudioService::class.java)
            .putExtra(ClassAudioService.EXTRA_MIC, micOn)
            .putExtra(ClassAudioService.EXTRA_CAMERA, cameraOn)
        if (micOn || cameraOn) {
            try {
                ContextCompat.startForegroundService(this, svc)
            } catch (e: Exception) {
                android.util.Log.w(TAG, "media service", e)
            }
        } else {
            stopService(svc)
        }
    }

    // ---- Camera -----------------------------------------------------------

    private fun hasPermission(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun ensureCameraThenToggle() {
        if (!cameraOn && !hasPermission(Manifest.permission.CAMERA)) {
            cameraPermission.launch(Manifest.permission.CAMERA)
            return
        }
        toggleCamera()
    }

    private fun toggleCamera() {
        lifecycleScope.launch { if (cameraOn) stopCamera() else startCamera() }
    }

    /**
     * Teacher camera, published like the web teacher's (source CAMERA, name
     * "camera"): 720p30 capture, top layer 1.5 Mbps / 30 fps, simulcast layers
     * 180p (140 kbps, 15 fps) and 360p (500 kbps, 24 fps) as in TEACHER_CAMERA.
     */
    private suspend fun startCamera() {
        val connected = room ?: return
        if (!isConnected() || cameraTrack != null) return
        binding.cameraButton.isEnabled = false
        var track: LocalVideoTrack? = null
        try {
            track = connected.localParticipant.createVideoTrack(
                "camera",
                LocalVideoTrackOptions(false, null, cameraPosition, VideoCaptureParameter(1280, 720, 30, true)),
                null,
            )
            track.startCapture()
            val ok = connected.localParticipant.publishVideoTrack(
                track,
                VideoTrackPublishOptions(
                    name = "camera",
                    videoEncoding = VideoEncoding(1_500_000, 30),
                    simulcast = true,
                    source = Track.Source.CAMERA,
                    simulcastLayers = listOf(
                        CustomVideoPreset(VideoCaptureParameter(320, 180, 15, true), VideoEncoding(140_000, 15)),
                        CustomVideoPreset(VideoCaptureParameter(640, 360, 24, true), VideoEncoding(500_000, 24)),
                    ),
                ),
            )
            if (!ok) throw ApiException("The camera did not start (state: ${connected.state.name.lowercase()})")
            cameraTrack = track
            cameraOn = true
            attachPreview(connected, track)
            updateMediaService()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (cameraTrack == null && track != null) disposeCamera(track, connected, unpublish = true)
            showError(e.message ?: "Could not start the camera")
        } finally {
            binding.cameraButton.isEnabled = room != null
            renderCamera()
        }
    }

    private fun stopCamera() {
        val track = cameraTrack
        cameraTrack = null
        cameraOn = false
        detachPreview(track)
        if (track != null) disposeCamera(track, room, unpublish = true)
        updateMediaService()
        renderCamera()
    }

    private fun disposeCamera(track: LocalVideoTrack, r: Room?, unpublish: Boolean) {
        if (unpublish) {
            try {
                r?.localParticipant?.unpublishTrack(track, true)
            } catch (e: Exception) {
                android.util.Log.w(TAG, "unpublish camera", e)
            }
        }
        try { track.stopCapture() } catch (_: Exception) {}
        try { track.stop() } catch (_: Exception) {}
        try { track.dispose() } catch (_: Exception) {}
    }

    private fun switchCamera() {
        val track = cameraTrack ?: return
        val next = if (cameraPosition == CameraPosition.FRONT) CameraPosition.BACK else CameraPosition.FRONT
        try {
            track.switchCamera(null, next)
            cameraPosition = next
            previewRenderer?.setMirror(next == CameraPosition.FRONT)
        } catch (e: Exception) {
            showError(e.message ?: "Could not switch camera")
        }
    }

    private fun attachPreview(r: Room, track: LocalVideoTrack) {
        detachPreview()
        try {
            val view = TextureViewRenderer(this)
            r.initVideoRenderer(view)
            view.setMirror(cameraPosition == CameraPosition.FRONT)
            binding.cameraPreview.addView(
                view,
                FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
            binding.cameraPreview.visibility = View.VISIBLE
            track.addRenderer(view)
            previewRenderer = view
        } catch (e: Exception) {
            android.util.Log.w(TAG, "camera preview", e)
        }
    }

    private fun detachPreview(track: LocalVideoTrack? = cameraTrack) {
        val view = previewRenderer ?: return
        previewRenderer = null
        try { track?.removeRenderer(view) } catch (_: Exception) {}
        try { view.release() } catch (_: Exception) {}
        binding.cameraPreview.removeAllViews()
        binding.cameraPreview.visibility = View.GONE
    }

    private fun renderCamera() {
        binding.cameraButton.text = if (cameraOn) "Turn camera off" else "Turn camera on"
        binding.switchCameraButton.isEnabled = cameraOn
        renderToolbar()
    }

    /** Drops camera and screen tracks (unpublish = false once the room is already gone). */
    private fun releaseLocalVideo(unpublish: Boolean) {
        val r = room
        cameraTrack?.let {
            detachPreview(it)
            cameraTrack = null
            disposeCamera(it, r, unpublish)
        }
        cameraOn = false
        screenTrack?.let {
            screenTrack = null
            disposeScreenTrack(it, r, unpublish)
        }
        if (::binding.isInitialized) renderCamera()
        updateMediaService()
    }

    // ---- Floating toolbar -------------------------------------------------

    private fun updateDisplaySize() {
        val size = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val b = getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds
            b.width() to b.height()
        } else {
            val p = Point()
            @Suppress("DEPRECATION")
            getSystemService(WindowManager::class.java).defaultDisplay.getRealSize(p)
            p.x to p.y
        }
        maskProcessor.displaySize = size
    }

    private fun onOverlayButton() {
        if (!Settings.canDrawOverlays(this)) {
            AlertDialog.Builder(this)
                .setTitle("Floating class controls")
                .setMessage(
                    "Shows a small button over other apps while you share or teach, with new chat, raised hands and " +
                        "waiting students, and quick controls. It is blacked out of what students see.\n\n" +
                        "Turn on \"Allow display over other apps\" for Classroom Teacher on the next screen.",
                )
                .setPositiveButton("Open setting") { _, _ -> openOverlaySettings() }
                .setNegativeButton("Cancel", null)
                .show()
            return
        }
        toolbarWanted = !toolbarWanted
        renderOverlayButton()
        updateToolbar()
    }

    private fun renderOverlayButton() {
        binding.overlayButton.text = when {
            !Settings.canDrawOverlays(this) -> "Floating toolbar: allow…"
            toolbarWanted -> "Floating toolbar: on (while sharing or away)"
            else -> "Floating toolbar: off"
        }
    }

    private val toolbarListener = object : FloatingToolbar.Listener {
        override fun onToggleMic() {
            if (!hasPermission(Manifest.permission.RECORD_AUDIO)) return openAppWith("Allow the microphone here first.")
            toggleMic()
        }

        override fun onToggleCamera() {
            if (!hasPermission(Manifest.permission.CAMERA)) return openAppWith("Allow the camera here first.")
            toggleCamera()
        }

        override fun onAdmitAll() = admitAll()

        override fun onAdmit(participantId: String) {
            lifecycleScope.launch {
                try {
                    withContext(Dispatchers.IO) { api?.admit(code, participantId) }
                    refreshState()
                } catch (e: SessionEndedException) {
                    sessionEnded(e)
                } catch (e: Exception) {
                    showError(e.message ?: "Could not admit")
                }
            }
        }

        override fun onMuteAll() = muteStudents(true)

        override fun onSendChat(text: String) {
            lifecycleScope.launch {
                try {
                    withContext(Dispatchers.IO) { api?.sendBroadcast(code, text) }
                    refreshChat()
                    markChatSeen()
                } catch (e: SessionEndedException) {
                    sessionEnded(e)
                } catch (e: Exception) {
                    showError(e.message ?: "Could not send")
                }
            }
        }

        override fun onStopShare() {
            lifecycleScope.launch { stopScreenShare() }
        }

        override fun onOpenApp() = openAppWith(null)

        override fun onMaskToggle(on: Boolean) {
            maskProcessor.enabled = on
            renderToolbar()
        }

        override fun onExpandedChanged(expanded: Boolean) {
            toolbarExpanded = expanded
            if (expanded) markChatSeen()
        }

        override fun onRectChanged(rect: IntRect?) {
            updateDisplaySize()
            maskProcessor.maskRect = rect
        }
    }

    private fun openAppWith(message: String?) {
        message?.let { showError(it) }
        try {
            startActivity(
                Intent(this, MainActivity::class.java).addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP,
                ),
            )
        } catch (e: Exception) {
            android.util.Log.w(TAG, "open app", e)
        }
    }

    /** Shown while sharing, or in class while the app is in the background; gone otherwise. */
    private fun updateToolbar() {
        val inClass = room != null
        val want = toolbarWanted && Settings.canDrawOverlays(this) && inClass && (sharing || !appVisible)
        if (!want) {
            toolbar?.hide()
            maskProcessor.maskRect = null
            return
        }
        val bar = toolbar ?: FloatingToolbar(
            ContextThemeWrapper(applicationContext, R.style.Theme_ClassroomTeacher),
            toolbarListener,
        ).also { toolbar = it }
        if (!bar.isShowing) bar.show()
        renderToolbar()
    }

    private fun renderToolbar() {
        val bar = toolbar ?: return
        if (!bar.isShowing) return
        bar.render(
            ToolbarState(
                sharing = sharing,
                micOn = micOn,
                cameraOn = cameraOn,
                waiting = waitingList,
                hands = handsRaised,
                focusAlerts = focusAlerts,
                unreadChat = unreadChat,
                recentChat = recentChat,
                maskOn = maskProcessor.enabled,
            ),
        )
    }

    private fun markChatSeen() {
        lastSeenChatId = chatIds.lastOrNull()
        unreadChat = 0
        renderToolbar()
    }

    private fun muteStudents(muted: Boolean) {
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) { api?.muteAll(code, muted) }
                binding.classStatus.text = if (muted) "Students muted" else "Students may unmute"
            } catch (e: SessionEndedException) {
                sessionEnded(e)
            } catch (e: Exception) {
                showError(e.message ?: "Could not change student microphones")
            }
        }
    }

    private fun admitAll() {
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) { api?.admitAll(code) }
                refreshState()
            } catch (e: SessionEndedException) {
                sessionEnded(e)
            } catch (e: Exception) {
                showError(e.message ?: "Could not admit students")
            }
        }
    }

    private fun sendChat() {
        val text = binding.chatInput.text.toString().trim()
        if (text.isEmpty()) return
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) { api?.sendBroadcast(code, text) }
                binding.chatInput.setText("")
                refreshChat()
            } catch (e: SessionEndedException) {
                sessionEnded(e)
            } catch (e: Exception) {
                showError(e.message ?: "Could not send")
            }
        }
    }

    private fun confirmEnd() {
        AlertDialog.Builder(this)
            .setTitle("End class for everyone?")
            .setPositiveButton("End class") { _, _ -> lifecycleScope.launch { endClass() } }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private suspend fun endClass() {
        try {
            if (sharing) stopScreenShare()
            withContext(Dispatchers.IO) { api?.end(code) }
        } catch (e: SessionEndedException) {
            return sessionEnded(e)
        } catch (e: Exception) {
            showError(e.message ?: "Could not end class")
        }
        disconnectRoom()
        loadHome()
    }

    private suspend fun leaveClass() {
        try {
            if (sharing) stopScreenShare()
            withContext(Dispatchers.IO) { api?.leave(code) }
        } catch (_: Exception) {
        }
        disconnectRoom()
        loadHome()
    }

    private suspend fun disconnectRoom() {
        pollJob?.cancel()
        val r = room ?: return
        leaving = true
        releaseLocalVideo(unpublish = true)
        room = null
        roomJob?.cancel()
        try {
            r.disconnect()
        } catch (_: Exception) {
        }
        setMic(false)
        sharing = false
        renderShareButtons()
        updateToolbar()
        waitingList = emptyList()
        chatIds = emptyList()
        lastSeenChatId = null
        unreadChat = 0
    }

    private fun startPolling() {
        pollJob?.cancel()
        pollJob = lifecycleScope.launch {
            while (isActive) {
                try {
                    if (!refreshState()) return@launch
                    renderConnection()
                    refreshChat()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: SessionEndedException) {
                    sessionEnded(e)
                    return@launch
                } catch (e: Exception) {
                    if ((e as? ApiException)?.status == 410) {
                        disconnectRoom()
                        showError("The class has ended.")
                        loadHome()
                        return@launch
                    }
                    binding.classStatus.text = "Reconnecting to the server…"
                }
                delay(2000)
            }
        }
    }

    /** @return false when the class ended (UI already moved on). */
    private suspend fun refreshState(): Boolean {
        val state = withContext(Dispatchers.IO) { api?.state(code) } ?: return false
        if (state.optString("status") == "ENDED" || state.optBoolean("ended")) {
            disconnectRoom()
            showError("The class has ended.")
            loadHome()
            return false
        }
        val waiting = state.optJSONArray("waiting") ?: JSONArray()
        renderWaiting(waiting)
        waitingList = (0 until waiting.length()).map {
            val w = waiting.getJSONObject(it)
            w.optString("id") to w.optString("displayName", "Student")
        }
        val admitted = state.optJSONArray("admitted") ?: JSONArray()
        var hands = 0
        var away = 0
        for (i in 0 until admitted.length()) {
            val a = admitted.getJSONObject(i)
            if (a.optString("role") != "STUDENT") continue
            if (a.optBoolean("handRaised")) hands++
            val f = a.optString("focus")
            if (f == "left" || f == "away") away++
        }
        handsRaised = hands
        focusAlerts = away
        renderToolbar()
        return true
    }

    private fun renderWaiting(waiting: JSONArray) {
        val n = waiting.length()
        val first = if (n > 0) waiting.getJSONObject(0).optString("displayName", "A student") else ""
        if (n > knownWaiting && !lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
            notifyWaiting(if (n == 1) "$first is waiting to join" else "$n students are waiting to join")
        }
        knownWaiting = n
        binding.waitingCard.visibility = if (n > 0) View.VISIBLE else View.GONE
        binding.waitingText.text = if (n == 1) "$first is waiting to join" else "$n students are waiting to join"
        binding.admitAllButton.text = if (n == 1) "Admit" else "Admit all ($n)"
    }

    @SuppressLint("MissingPermission")
    private fun notifyWaiting(text: String) {
        if (needsNotificationPermission()) return
        getSystemService(NotificationManager::class.java).notify(Notifications.WAITING_ID, Notifications.waiting(this, text))
    }

    private suspend fun refreshChat() {
        val payload = withContext(Dispatchers.IO) { api?.messages(code) } ?: return
        val messages = payload.optJSONArray("messages") ?: JSONArray()
        val lines = buildString {
            for (i in 0 until messages.length()) {
                val m = messages.getJSONObject(i)
                append(m.optString("senderName", "Someone")).append(": ").append(m.optString("body")).append('\n')
            }
        }
        binding.chatLog.text = lines.trimEnd().ifBlank { "No messages yet." }
        val ids = ArrayList<String>()
        val recent = ArrayList<String>()
        for (i in 0 until messages.length()) {
            val m = messages.getJSONObject(i)
            ids.add(m.optString("id").ifBlank { "$i:${m.optString("createdAt")}:${m.optString("body").hashCode()}" })
            if (i >= messages.length() - 4) recent.add("${m.optString("senderName", "Someone")}: ${m.optString("body")}")
        }
        chatIds = ids
        recentChat = recent
        if (lastSeenChatId == null && unreadChat == 0 && ids.isNotEmpty() && appVisible) lastSeenChatId = ids.last()
        if (appVisible && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) || toolbarExpanded) {
            markChatSeen()
        } else {
            val seen = lastSeenChatId
            val idx = if (seen == null) -1 else ids.lastIndexOf(seen)
            unreadChat = if (idx >= 0) ids.size - 1 - idx else if (seen == null) ids.size else minOf(ids.size, 9)
            renderToolbar()
        }
    }

    private fun note(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(0xFFE2E8F0.toInt())
        textSize = 15f
        setPadding(0, 12, 0, 12)
    }

    private fun showOnly(group: View) {
        listOf(binding.loginGroup, binding.homeGroup, binding.classGroup, binding.handoffGroup)
            .forEach { it.visibility = if (it === group) View.VISIBLE else View.GONE }
        clearError()
    }

    private fun showError(message: String) {
        binding.errorText.text = message
    }

    private fun clearError() {
        binding.errorText.text = ""
    }

    companion object {
        private const val TAG = "ClassroomTeacher"
        private const val PREFS = "classroom_teacher"
        private const val KEY_SERVER = "server"
        private const val KEY_EMAIL = "email"
        private const val KEY_NAME = "name"
        private const val KEY_COOKIE = "session"
    }
}
