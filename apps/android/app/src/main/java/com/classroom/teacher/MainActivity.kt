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
import androidx.appcompat.widget.PopupMenu
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.VideoQuality
import io.livekit.android.room.track.VideoTrack
import com.classroom.teacher.databinding.ActivityMainBinding
import io.livekit.android.AudioOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.audio.AudioProcessorOptions
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
import io.livekit.android.room.track.LocalTrackPublication
import io.livekit.android.room.track.DataPublishReliability
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
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.channels.Channel
import org.json.JSONArray
import org.json.JSONObject
import com.classroom.teacher.wb.Doc
import com.classroom.teacher.wb.Item
import com.classroom.teacher.wb.Wb
import com.classroom.teacher.wb.WbHost
import com.classroom.teacher.wb.WbOps
import com.classroom.teacher.wb.WhiteboardScreen
import com.classroom.teacher.wb.WbCodec
import com.classroom.teacher.wb.WbFiles
import com.classroom.teacher.wb.WbStyle

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
    /** Server "state changed" / chat pushes (LiveKit data) wake the poll loop early. */
    private val pollWake = Channel<Unit>(Channel.CONFLATED)
    @Volatile private var chatDue = false
    private var knownWaiting = 0
    private var pendingCapture = false
    /** Set while this device deliberately leaves, so the Disconnected event is not shown as an error. */
    private var leaving = false
    private var grades: List<GradeChoice> = emptyList()

    // Camera
    private var cameraOn = false
    private var cameraTrack: LocalVideoTrack? = null
    private var cameraPosition = CameraPosition.FRONT

    // Screen share (published by hand so frames pass through the mask processor)
    private var screenTrack: LocalScreencastVideoTrack? = null
    private val maskProcessor = ScreenMaskProcessor()
    /** Teacher mic: voice focus after the phone's own processing (docs/AUDIO.md). Long-press the mic to toggle. */
    private val voiceFocus = VoiceFocusProcessor()

    // Floating toolbar
    private var toolbar: FloatingToolbar? = null
    private var toolbarWanted = true
    private var overlayExplained = false
    private var pendingShareAfterOverlay = false
    private var appVisible = false
    private var waitingList: List<Pair<String, String>> = emptyList()
    private var handsRaised = 0
    private var focusAlerts = 0
    private var recentChat: List<String> = emptyList()
    private var chatIds: List<String> = emptyList()
    private var lastSeenChatId: String? = null
    private var unreadChat = 0

    // In-class screen: icon rail, video column, chat / roster panel
    private lateinit var railShare: RailButton
    private lateinit var railMic: RailButton
    private lateinit var railCamera: RailButton
    private lateinit var railSwitch: RailButton
    private lateinit var railChat: RailButton
    private lateinit var railRoster: RailButton
    private lateinit var railMuteAll: RailButton
    private lateinit var railAllowUnmute: RailButton
    private lateinit var railBubble: RailButton
    private lateinit var railLeave: RailButton
    private lateinit var railEnd: RailButton
    private lateinit var tileGrid: TileGrid
    private val tiles = ArrayList<VideoTile>()
    private var panel: ClassPanel? = null
    private var panelKind: ClassPanel.Kind? = null
    private var chatText = ""
    private var students: List<StudentInfo> = emptyList()
    private var visibleIdentities: List<String> = emptyList()
    private var maxVisible = ClassLogic.STUDENT_TILES
    /** Unmuted students who spoke: keep their tile until they mute (as on the web). */
    private val stickySpeakers = LinkedHashSet<String>()
    private var speakingId: String? = null
    private var rotationOrder: List<String> = emptyList()
    private var rotationJob: Job? = null
    private var toastJob: Job? = null
    private var waitingRoomOn = true

    // Share pause (projection kept), spotlight, speaking queue, drawing.
    private var sharePaused = false
    private var keepSharingOnReturn = false
    private var spotlightId: String? = null
    private var spotlightName: String? = null
    private var micQueue: List<ClassLogic.MicWaiter> = emptyList()
    private val drawAllowed = HashMap<String, Long>()
    private var inkStrokes: MutableList<Realtime.InkStroke> = ArrayList()
    private var inkOverlay: InkOverlay? = null
    private var chatMessages: List<JSONObject> = emptyList()
    private var chatSince: String? = null
    /** (participant id, name) when the newest chat message is a student's private question. */
    private var chatQuestion: Pair<String, String>? = null
    /** The server's MEDIA_PROFILE (sent with the LiveKit token): camera / share bitrates. */
    private var mediaProfile = Media.Profile.STANDARD
    /** Last /api/auth/me (renews the sliding 24 h session). */
    private var lastRenew = 0L
    private var videoPanelSent: Boolean? = null
    private val errorReporter = ErrorReporter()

    // Whiteboard (this device hosts it).
    private var wbHost: WbHost? = null
    private var wbScreen: WhiteboardScreen? = null
    private var wbServerOn = false
    private var wbSaveJob: Job? = null
    private var wbStoreJob: Job? = null
    private var wbSavedVersion = -1
    private var wbStoredVersion = -1
    private var wbLastStore = 0L
    private lateinit var railBoard: RailButton

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

    /** Whiteboard: insert a picture from the gallery / files. */
    private val boardImagePicker = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@registerForActivityResult
        lifecycleScope.launch {
            val bmp = withContext(Dispatchers.IO) { WbFiles.decodeImage(contentResolver, uri) }
            if (bmp == null) showError("That picture could not be opened.") else wbScreen?.board?.insertImage(bmp)
        }
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
        val insetTypes = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
        ViewCompat.setOnApplyWindowInsetsListener(binding.scroll) { v, insets ->
            val bars = insets.getInsets(insetTypes)
            v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        // The class screen keeps every edge clear of bars, cutouts (landscape
        // notch on the rail side) and the keyboard (chat input in the panel).
        ViewCompat.setOnApplyWindowInsetsListener(binding.classScreen) { v, insets ->
            val bars = insets.getInsets(insetTypes)
            v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        installCrashReporter()
        buildClassScreen()
        applyResponsiveLayout()

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        voiceFocus.on = prefs.getBoolean(KEY_VOICE_FOCUS, true)
        binding.serverInput.setText(prefs.getString(KEY_SERVER, null) ?: ClassroomApi.DEFAULT_SERVER)
        binding.emailInput.setText(prefs.getString(KEY_EMAIL, "") ?: "")

        binding.loginButton.setOnClickListener { login() }
        binding.logoutButton.setOnClickListener { logout() }
        binding.refreshButton.setOnClickListener { loadHome() }
        binding.rejoinButton.setOnClickListener { binding.rejoinButton.tag?.toString()?.let { enterClass(it) } }
        binding.adhocButton.setOnClickListener { startAdHoc() }
        binding.admitAllButton.setOnClickListener { admitAll() }
        binding.waitingBanner.setOnClickListener { openPanel(ClassPanel.Kind.ROSTER) }
        binding.sheetHost.setOnClickListener { closePanel() }
        binding.useHereButton.setOnClickListener { enterClass(code) }
        binding.handoffHomeButton.setOnClickListener { loadHome() }
        binding.gradeSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) = renderDivisions()
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }
        ShareStopReceiver.onStopRequested = { lifecycleScope.launch { stopScreenShare() } }
        application.registerComponentCallbacks(displayCallbacks)
        updateDisplaySize()
        renderRail()
        if (intent?.getBooleanExtra(EXTRA_STOP_SHARE, false) == true) intent.removeExtra(EXTRA_STOP_SHARE)

        // Resume a saved session (the server may have replaced it meanwhile).
        val savedCookie = CookieVault.open(prefs.getString(KEY_COOKIE, null))
        val savedServer = prefs.getString(KEY_SERVER, null)
        val serverProblem = savedServer?.let { ServerAddress.problem(it) }
        if (savedCookie != null && savedServer != null && serverProblem == null) {
            api = ClassroomApi(savedServer).also {
                it.teacherCookie = savedCookie
                it.onCookieChange = ::persistCookie
            }
            binding.helloText.text = prefs.getString(KEY_NAME, null)?.let { "Signed in as $it" } ?: ""
            loadHome()
        } else {
            if (savedCookie != null) forgetSession()
            showOnly(binding.loginGroup)
            serverProblem?.let { showError(it) }
        }
        // Keep the sliding session alive while the app is open (also in the background while sharing).
        lifecycleScope.launch {
            while (isActive) {
                delay(RENEW_MS)
                renewSession()
            }
        }
    }

    /**
     * The server signs teachers out after 24 h without use; /api/auth/me
     * renews the session. Called every 30 minutes and when the app comes back.
     */
    private fun renewSession() {
        val client = api ?: return
        if (client.teacherCookie == null) return
        val now = System.currentTimeMillis()
        if (now - lastRenew < RENEW_MS) return
        lastRenew = now
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) { client.me() }
            } catch (e: SessionEndedException) {
                if (api === client) sessionEnded(e)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                lastRenew = 0L // offline: try again next time
                android.util.Log.w(TAG, "session renewal", e)
            }
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyResponsiveLayout()
        updateDisplaySize()
    }

    /** Notification "back to class" while sharing: open the app and pause the share (capture stays granted). */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra(EXTRA_STOP_SHARE, false)) {
            intent.removeExtra(EXTRA_STOP_SHARE)
            if (sharing && !sharePaused) lifecycleScope.launch { pauseShare() }
        }
    }

    override fun onStart() {
        super.onStart()
        appVisible = true
        // Back in the app while sharing: pause (students would otherwise see
        // this screen), unless the teacher chose "Open app (keep sharing)".
        if (sharing && !sharePaused && !keepSharingOnReturn) lifecycleScope.launch { pauseShare() }
        keepSharingOnReturn = false
        updateToolbar()
        renderVideos() // resubscribe the shown cameras
        syncVideoPanel()
        pollWake.trySend(Unit) // back to the visible poll cadence now
        renewSession()
    }

    override fun onStop() {
        appVisible = false
        updateToolbar()
        renderVideos() // drops student camera subscriptions while hidden
        syncVideoPanel()
        flushWhiteboardSave()
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        getSystemService(NotificationManager::class.java).cancel(Notifications.WAITING_ID)
        if (panelKind == ClassPanel.Kind.CHAT) markChatSeen()
        renderRail()
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
        rotationJob?.cancel()
        releaseLocalVideo(unpublish = false)
        tiles.forEach { it.releaseRenderer() }
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
        applyClassLayout()
        // Short landscape phones: drop the subtitle to keep the controls visible.
        binding.appSubtitle.visibility = if (cfg.screenHeightDp < 480) View.GONE else View.VISIBLE
    }

    // ---- Sign in / classes ------------------------------------------------

    private fun login() {
        val server = binding.serverInput.text.toString().trim()
        val email = binding.emailInput.text.toString().trim()
        val password = binding.passwordInput.text.toString()
        ServerAddress.problem(server)?.let {
            showError(it)
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
                    .putString(KEY_COOKIE, client.teacherCookie?.let(CookieVault::seal))
                    .apply()
                lastRenew = System.currentTimeMillis()
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
        if (cookie == null) e.remove(KEY_COOKIE) else e.putString(KEY_COOKIE, CookieVault.seal(cookie))
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
        // Teachers on more than one campus pick the campus with the grade.
        val severalCampuses = grades.map { it.campus }.distinct().size > 1
        binding.gradeSpinner.adapter = spinnerAdapter(
            grades.map { if (severalCampuses) "${it.campus} · Grade ${it.label}" else "Grade ${it.label}" },
        )
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
                val res = withContext(Dispatchers.IO) { client.startAdHoc(g.campus, g.grade, division, subject) }
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
        showOnly(binding.classScreen)
        binding.classTitle.text = if (label.isNotBlank()) "$label · $code" else "Class $code"
        binding.classStatus.text = "Connecting…"
        students = emptyList()
        visibleIdentities = emptyList()
        stickySpeakers.clear()
        speakingId = null
        chatMessages = emptyList()
        chatSince = null
        chatQuestion = null
        videoPanelSent = null
        spotlightId = null
        spotlightName = null
        micQueue = emptyList()
        drawAllowed.clear()
        inkStrokes = ArrayList()
        renderRail()
        renderVideos()
        lifecycleScope.launch {
            try {
                disconnectRoom()
                val info = withContext(Dispatchers.IO) { client.token(code) }
                val url = info.optString("url")
                val token = info.optString("token")
                if (url.isBlank() || token.isBlank()) throw ApiException("The server did not return a media address.")
                mediaProfile = Media.parseProfile(info.opt("mediaProfile"))
                val connected = LiveKit.create(
                    applicationContext,
                    overrides = LiveKitOverrides(
                        audioOptions = AudioOptions(audioProcessorOptions = AudioProcessorOptions(capturePostProcessor = voiceFocus)),
                    ),
                )
                room = connected
                leaving = false
                listen(connected)
                connected.connect(url, token)
                binding.classStatus.text = "In class · students join muted"
                renderRail()
                renderVideos()
                startRotation()
                updateToolbar()
                // The video column shows three students: let the server sample
                // (who may publish camera) match, so pins count toward it.
                launch(Dispatchers.IO) {
                    try {
                        client.setVideoCap(code, ClassLogic.STUDENT_TILES)
                    } catch (e: Exception) {
                        android.util.Log.w(TAG, "video cap", e)
                    }
                }
                if (needsNotificationPermission()) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                syncVideoPanel()
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
                if (connected !== room) return@collect
                when (event) {
                    is RoomEvent.Disconnected -> onDisconnected(event.reason)
                    is RoomEvent.ActiveSpeakersChanged -> onSpeakers(event.speakers)
                    is RoomEvent.TrackPublished, is RoomEvent.TrackUnpublished,
                    is RoomEvent.TrackSubscribed, is RoomEvent.TrackUnsubscribed,
                    is RoomEvent.TrackMuted, is RoomEvent.TrackUnmuted,
                    is RoomEvent.ParticipantDisconnected,
                    -> renderVideos()
                    is RoomEvent.ParticipantConnected -> {
                        renderVideos()
                        // Late joiner: send the open whiteboard straight away.
                        event.participant.identity?.value?.let { id -> wbHost?.sendSnapshot(listOf(id)) }
                    }
                    is RoomEvent.Reconnecting -> {
                        binding.classStatus.text = "Reconnecting…"
                        showToast("Reconnecting…")
                    }
                    is RoomEvent.Reconnected -> {
                        binding.classStatus.text = if (sharing && !sharePaused) "Sharing this device's screen with the class" else "In class · students join muted"
                        wbHost?.sendSnapshot()
                        pollWake.trySend(Unit)
                    }
                    is RoomEvent.DataReceived -> onData(event.participant?.identity?.value, event.topic, event.data)
                    else -> Unit
                }
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
            renderRail()
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
                    binding.classStatus.text = if (sharing) "Sharing this device's screen with the class" else "In class · students join muted"
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
                    "When you share, this app steps aside and leaves a small floating bubble on screen. It lights up " +
                        "for students waiting, raised hands and new messages. Tap it to stop sharing and come straight back " +
                        "to the class (long-press for more).\n\n" +
                        "Android needs the \"Display over other apps\" permission for this. The bubble is blacked out " +
                        "of what students see.\n\nWithout it, sharing still works: tap the \"Screen share\" notification " +
                        "to stop and come back.",
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
            val preset = Media.share(mediaProfile)
            track = connected.localParticipant.createScreencastTrack(
                "screen",
                data,
                LocalVideoTrackOptions(true, null, CameraPosition.FRONT, VideoCaptureParameter(cw, ch, preset.fps, true)),
                maskProcessor,
            ) { lifecycleScope.launch { onShareStoppedBySystem() } }
            track.startForegroundService(Notifications.SHARE_ID, Notifications.screenShare(this))
            maskProcessor.paused = false
            maskProcessor.resetSecureCheck()
            track.startCapture()
            // Top layer 2 Mbps / 15 fps (low profile: 1 Mbps / 10 fps), plus a
            // 720p layer so phones / weak links get a readable share (web screenShareSimulcastFor).
            val low = Realtime.shareLowLayer(cw, ch)
            val ok = connected.localParticipant.publishVideoTrack(
                track,
                VideoTrackPublishOptions(
                    name = "screen",
                    videoEncoding = VideoEncoding(preset.maxBitrate, preset.fps),
                    simulcast = low != null,
                    source = Track.Source.SCREEN_SHARE,
                    simulcastLayers = if (low != null) {
                        listOf(
                            CustomVideoPreset(
                                VideoCaptureParameter(low.first, low.second, preset.lowLayerFps, true),
                                VideoEncoding(preset.lowLayerBitrate, preset.lowLayerFps),
                            ),
                        )
                    } else {
                        emptyList()
                    },
                ),
            )
            if (!ok) throw ApiException("Screen share did not start (state: ${connected.state.name.lowercase()})")
            screenTrack = track
            sharing = true
            sharePaused = false
            renderRail()
            updateToolbar()
            binding.classStatus.text = "Sharing this device's screen with the class"
            // Step aside so the teacher lands on what they want to show; the
            // bubble (or the notification) brings them back and stops the share.
            val bubble = toolbarWanted && Settings.canDrawOverlays(this)
            if (!bubble) {
                showError(
                    if (!Settings.canDrawOverlays(this)) "Sharing. The floating bubble needs the \"Display over other apps\" permission, so to come back tap the \"Sharing your screen\" notification: it stops the share and opens the class."
                    else "Sharing. To come back, tap the \"Sharing your screen\" notification: it stops the share and opens the class.",
                )
            }
            // Give the teacher time to read the hint when there is no bubble.
            delay(if (bubble) 350 else 3000)
            if (sharing) moveTaskToBack(true)
            startInk()
            withContext(Dispatchers.IO) { api?.stage(code, "screen", desktopInk = inkOverlay?.shown == true) }
        } catch (e: SessionEndedException) {
            sessionEnded(e)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (screenTrack == null && track != null) disposeScreenTrack(track, connected, unpublish = true)
            sharing = false
            renderRail()
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
        maskProcessor.paused = false
        stopInk()
        val was = sharing
        sharing = false
        sharePaused = false
        renderRail()
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

    /** Long-press on the mic: voice focus on or off for this phone (saved). */
    private fun toggleVoiceFocus() {
        voiceFocus.on = !voiceFocus.on
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_VOICE_FOCUS, voiceFocus.on).apply()
        showToast(
            if (voiceFocus.on) "Voice focus on: voices and sounds well below yours are turned down between your sentences."
            else "Voice focus off: the phone's own noise suppression only.",
        )
        renderRail()
    }

    private fun setMic(on: Boolean) {
        micOn = on
        updateMediaService()
        renderRail()
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
     * "camera", TEACHER_CAMERA): 360p / 15 fps / 300 kbps plus a 180p 90 kbps
     * layer; with the server's low media profile one 180p layer at 120 kbps.
     * Every student receives this stream, so it stays small.
     */
    private suspend fun startCamera() {
        val connected = room ?: return
        if (!isConnected() || cameraTrack != null) return
        railCamera.isEnabled = false
        var track: LocalVideoTrack? = null
        try {
            val preset = Media.camera(mediaProfile)
            track = connected.localParticipant.createVideoTrack(
                "camera",
                LocalVideoTrackOptions(false, null, cameraPosition, VideoCaptureParameter(preset.width, preset.height, preset.fps, true)),
                null,
            )
            track.startCapture()
            val ok = connected.localParticipant.publishVideoTrack(
                track,
                VideoTrackPublishOptions(
                    name = "camera",
                    videoEncoding = VideoEncoding(preset.maxBitrate, preset.fps),
                    simulcast = preset.layers.isNotEmpty(),
                    source = Track.Source.CAMERA,
                    simulcastLayers = preset.layers.map {
                        CustomVideoPreset(VideoCaptureParameter(it.width, it.height, it.fps, true), VideoEncoding(it.maxBitrate, it.fps))
                    },
                ),
            )
            if (!ok) throw ApiException("The camera did not start (state: ${connected.state.name.lowercase()})")
            cameraTrack = track
            cameraOn = true
            renderVideos()
            updateMediaService()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (cameraTrack == null && track != null) disposeCamera(track, connected, unpublish = true)
            showError(e.message ?: "Could not start the camera")
        } finally {
            railCamera.isEnabled = true
            renderCamera()
        }
    }

    private fun stopCamera() {
        val track = cameraTrack
        cameraTrack = null
        cameraOn = false
        renderVideos() // detaches the self tile before the track is disposed
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
            renderVideos()
        } catch (e: Exception) {
            showError(e.message ?: "Could not switch camera")
        }
    }

    private fun renderCamera() {
        renderRail()
        renderToolbar()
    }

    /** Drops camera and screen tracks (unpublish = false once the room is already gone). */
    private fun releaseLocalVideo(unpublish: Boolean) {
        val r = room
        cameraTrack?.let {
            cameraTrack = null
            if (::tileGrid.isInitialized) renderVideos()
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

    // ---- Class screen: rail, video column, panels --------------------------

    private fun buildClassScreen() {
        val rail = binding.rail
        fun add(icon: Int, label: String, gapBefore: Int = 6, onClick: () -> Unit) = RailButton(this).also { b ->
            b.setIcon(icon)
            b.label = label
            b.setOnClickListener { onClick() }
            rail.addView(b, LinearLayout.LayoutParams(dp(52), dp(52)).apply { topMargin = dp(gapBefore) })
        }
        railShare = add(R.drawable.ic_screen_share, "Share screen", 0) { onShareButton() }
        railBoard = add(R.drawable.ic_board, "Whiteboard") { if (wbHost != null) showWhiteboardView() else openWhiteboard() }
        railMic = add(R.drawable.ic_mic_off, "Turn microphone on") { ensureMicThenToggle() }
        railMic.setOnLongClickListener {
            toggleVoiceFocus()
            true
        }
        railCamera = add(R.drawable.ic_videocam_off, "Turn camera on") { ensureCameraThenToggle() }
        railSwitch = add(R.drawable.ic_cameraswitch, "Switch camera") { switchCamera() }
        railChat = add(R.drawable.ic_chat, "Chat", 14) { togglePanel(ClassPanel.Kind.CHAT) }
        railRoster = add(R.drawable.ic_group, "Students and waiting room") { togglePanel(ClassPanel.Kind.ROSTER) }
        railMuteAll = add(R.drawable.ic_volume_off, "Mute all students", 14) { muteStudents(true) }
        railAllowUnmute = add(R.drawable.ic_record_voice_over, "Allow all students to unmute") { muteStudents(false) }
        railBubble = add(R.drawable.ic_bubble, "Floating bubble") { onOverlayButton() }
        railLeave = add(R.drawable.ic_logout, "Leave (class keeps running)", 14) { lifecycleScope.launch { leaveClass() } }
        railEnd = add(R.drawable.ic_call_end, "End class for everyone") { confirmEnd() }
        railEnd.setStyle(RailButton.Style.DANGER)

        tileGrid = TileGrid(this)
        repeat(1 + ClassLogic.STUDENT_TILES) { i ->
            val tile = VideoTile(this)
            if (i > 0) {
                tile.isClickable = true
                tile.setOnClickListener { v -> tileMenu(v as VideoTile) }
                tile.setOnLongClickListener { v -> tileMenu(v as VideoTile); true }
            }
            tiles.add(tile)
            tileGrid.addView(tile)
        }
        binding.videoArea.addView(tileGrid, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    /** Panels sit beside the videos when there is room (landscape / ≥ 720dp wide), else as a bottom sheet. */
    private fun panelOnSide(): Boolean {
        val cfg = resources.configuration
        return cfg.screenWidthDp >= 720 || (cfg.orientation == Configuration.ORIENTATION_LANDSCAPE && cfg.screenWidthDp >= 560)
    }

    /**
     * Portrait: rail on the left, the four tiles as a 2x2 block filling the
     * rest, chat / roster as a bottom sheet. Landscape: rail on the left, the
     * tiles in a row (or 2x2 when tall enough), panels in a right column.
     * Short screens get a tighter rail; tablets get bigger tiles for free.
     */
    private fun applyClassLayout() {
        if (!::tileGrid.isInitialized) return
        val cfg = resources.configuration
        val short = cfg.screenHeightDp < 420
        val size = dp(if (short) 44 else 52)
        for (i in 0 until binding.rail.childCount) {
            val v = binding.rail.getChildAt(i)
            v.layoutParams = (v.layoutParams as LinearLayout.LayoutParams).apply {
                width = size
                height = size
                if (topMargin > 0) topMargin = dp(if (short) 4 else if (topMargin >= dp(14)) 14 else 6)
            }
        }
        binding.classStatus.visibility = if (short) View.GONE else View.VISIBLE
        tileGrid.aspect = if (cfg.orientation == Configuration.ORIENTATION_LANDSCAPE) 16f / 9f else 4f / 3f
        tileGrid.requestLayout()
        binding.sidePanelHost.layoutParams = binding.sidePanelHost.layoutParams.apply {
            width = (minOf(420, maxOf(300, (cfg.screenWidthDp * 0.36f).toInt())) * resources.displayMetrics.density).toInt()
        }
        panelKind?.let { placePanel() }
        wbScreen?.setCompact(windowClass() == WindowClass.COMPACT)
    }

    private fun ensurePanel(): ClassPanel = panel ?: ClassPanel(this, panelListener).also { panel = it }

    private fun togglePanel(kind: ClassPanel.Kind) {
        if (panelKind == kind) closePanel() else openPanel(kind)
    }

    private fun openPanel(kind: ClassPanel.Kind) {
        val p = ensurePanel()
        p.show(kind)
        panelKind = kind
        placePanel()
        if (kind == ClassPanel.Kind.CHAT) {
            p.renderChat(chatText, chatQuestion)
            markChatSeen()
        } else {
            renderRosterPanel()
        }
        renderRail()
    }

    private fun closePanel() {
        val p = panel
        panelKind = null
        if (p != null) (p.parent as? ViewGroup)?.removeView(p)
        if (::binding.isInitialized) {
            binding.sidePanelHost.visibility = View.GONE
            binding.sheetHost.visibility = View.GONE
        }
        if (::railChat.isInitialized) renderRail()
    }

    private fun placePanel() {
        val p = panel ?: return
        (p.parent as? ViewGroup)?.removeView(p)
        if (panelOnSide()) {
            binding.sheetHost.visibility = View.GONE
            binding.sidePanelHost.visibility = View.VISIBLE
            binding.sidePanelHost.addView(p, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        } else {
            binding.sidePanelHost.visibility = View.GONE
            binding.sheetHost.visibility = View.VISIBLE
            val h = (resources.displayMetrics.heightPixels * 0.62f).toInt()
            binding.sheetHost.addView(
                p,
                FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, h, android.view.Gravity.BOTTOM).apply {
                    leftMargin = dp(8)
                    rightMargin = dp(8)
                    bottomMargin = dp(8)
                },
            )
        }
    }

    private val panelListener = object : ClassPanel.Listener {
        override fun onClosePanel() = closePanel()
        override fun onSendChat(text: String, to: String?) = sendChat(text, to)
        override fun onAdmit(participantId: String) = admitOne(participantId)
        override fun onAdmitAll() = admitAll()
        override fun onMuteStudent(participantId: String, muted: Boolean) = studentAction("Could not change the microphone") {
            it.muteOne(code, participantId, muted)
        }
        override fun onPinStudent(participantId: String, pinned: Boolean) = pinStudent(participantId, pinned)
        override fun onLowerHand(participantId: String) = studentAction("Could not lower the hand") { it.lowerHand(code, participantId) }
        override fun onWaitingRoom(on: Boolean) {
            waitingRoomOn = on
            showToast(if (on) "Waiting room on: you admit each student." else "Waiting room off: students enter directly, muted.")
            studentAction("Could not change the waiting room") { it.setWaitingRoom(code, on) }
        }
        override fun onSpotlight(participantId: String?) = studentAction("Could not change the spotlight") { it.spotlight(code, participantId) }
        override fun onDrawAllow(participantId: String) {
            if (!canAllowDraw()) return showError("Share your screen or the whiteboard first")
            studentAction("Could not allow drawing") { it.draw(code, "allow", participantId) }
        }
        override fun onDrawDeny(participantId: String) = studentAction("Could not answer the request") { it.draw(code, "revoke", participantId) }
        override fun onDrawRevoke(participantId: String?) = studentAction("Could not stop the drawing") { it.draw(code, "revoke", participantId) }
        override fun onDrawClear() = studentAction("Could not clear the drawing") { it.draw(code, "clear") }
    }

    private fun renderRosterPanel() {
        val p = panel ?: return
        if (panelKind != ClassPanel.Kind.ROSTER) return
        p.renderRoster(
            ClassPanel.Roster(
                waiting = waitingList,
                students = students,
                pinsFull = students.count { it.pinned } >= maxVisible,
                waitingRoomOn = waitingRoomOn,
                spotlightId = spotlightId,
                spotlightName = spotlightName,
                micQueue = micQueue,
                canAllowDraw = canAllowDraw(),
            ),
        )
    }

    /** Run a teacher action against the API, then refresh the class state. */
    private fun studentAction(errorText: String, admitting: Boolean = false, block: (ClassroomApi) -> Unit) {
        val client = api ?: return
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) { block(client) }
                refreshState()
            } catch (e: SessionEndedException) {
                sessionEnded(e)
            } catch (e: Exception) {
                if (admitting && (e as? ApiException)?.status == 409) showError(Realtime.classFullMessage(e.message))
                else showError(e.message ?: errorText)
            }
        }
    }

    private fun admitOne(participantId: String) = studentAction("Could not admit", admitting = true) { it.admit(code, participantId) }

    private fun pinStudent(participantId: String, pinned: Boolean) {
        if (pinned && students.count { it.pinned } >= maxVisible) {
            showError("All $maxVisible video places are pinned. Unpin someone first.")
            return
        }
        studentAction("Could not change the pin") { it.pinStudent(code, participantId, pinned) }
    }

    private fun tileMenu(tile: VideoTile) {
        val identity = tile.identity ?: return
        val s = students.firstOrNull { it.identity == identity } ?: return
        PopupMenu(this, tile).apply {
            menu.add(0, 1, 0, if (s.pinned) "Unpin ${s.name}" else "Pin ${s.name} (keep in view)")
            menu.add(0, 2, 1, if (s.muted) "Unmute ${s.name}" else "Mute ${s.name}")
            if (s.handRaised) menu.add(0, 3, 2, "Lower hand")
            menu.add(0, 4, 3, if (spotlightId == s.id) "Stop spotlight" else "Spotlight ${s.name}")
            setOnMenuItemClickListener { item ->
                when (item.itemId) {
                    1 -> pinStudent(s.id, !s.pinned)
                    2 -> panelListener.onMuteStudent(s.id, !s.muted)
                    3 -> panelListener.onLowerHand(s.id)
                    4 -> panelListener.onSpotlight(if (spotlightId == s.id) null else s.id)
                }
                true
            }
            show()
        }
    }

    /** Icons and on/off states of the rail; badges for chat and the roster. */
    private fun renderRail() {
        if (!::railShare.isInitialized) return
        val connected = room != null && room?.state == Room.State.CONNECTED
        railShare.setIcon(if (sharing && !sharePaused) R.drawable.ic_stop_screen_share else R.drawable.ic_screen_share)
        railShare.label = when {
            sharing && sharePaused -> "Share paused. Tap to resume or stop"
            sharing -> "Sharing. Tap to pause or stop"
            else -> "Share screen"
        }
        railShare.setStyle(
            when {
                sharing && sharePaused -> RailButton.Style.OFF_WARN
                sharing -> RailButton.Style.DANGER
                else -> RailButton.Style.NEUTRAL
            },
        )
        railShare.isEnabled = connected || sharing
        railBoard.setStyle(if (wbHost != null) RailButton.Style.ACTIVE else RailButton.Style.NEUTRAL)
        railBoard.label = if (wbHost != null) "Whiteboard open. Tap to show it" else "Open the whiteboard"
        railBoard.isEnabled = connected || wbHost != null
        railMic.setIcon(if (micOn) R.drawable.ic_mic else R.drawable.ic_mic_off)
        railMic.label = (if (micOn) "Microphone on. Tap to mute" else "Microphone off. Tap to speak") +
            if (voiceFocus.on) ". Voice focus on (long-press to turn off)" else ". Long-press for voice focus"
        railMic.setStyle(if (micOn) RailButton.Style.ON else RailButton.Style.OFF_WARN)
        railMic.isEnabled = connected
        railCamera.setIcon(if (cameraOn) R.drawable.ic_videocam else R.drawable.ic_videocam_off)
        railCamera.label = if (cameraOn) "Camera on. Tap to turn off" else "Camera off. Tap to turn on"
        railCamera.setStyle(if (cameraOn) RailButton.Style.ON else RailButton.Style.OFF_WARN)
        railCamera.isEnabled = connected
        railSwitch.label = if (cameraPosition == CameraPosition.FRONT) "Switch to back camera" else "Switch to front camera"
        railSwitch.isEnabled = cameraOn
        railChat.setStyle(if (panelKind == ClassPanel.Kind.CHAT) RailButton.Style.ACTIVE else RailButton.Style.NEUTRAL)
        railChat.setBadge(unreadChat, 0xFF3B82F6.toInt())
        railRoster.setStyle(if (panelKind == ClassPanel.Kind.ROSTER) RailButton.Style.ACTIVE else RailButton.Style.NEUTRAL)
        railRoster.setBadge(waitingList.size + handsRaised + students.count { it.drawRequested && !it.drawing })
        railMuteAll.isEnabled = room != null
        railAllowUnmute.isEnabled = room != null
        val canOverlay = Settings.canDrawOverlays(this)
        railBubble.label = when {
            !canOverlay -> "Floating bubble: needs permission"
            toolbarWanted -> "Floating bubble on. Tap to turn off"
            else -> "Floating bubble off. Tap to turn on"
        }
        railBubble.setStyle(if (canOverlay && toolbarWanted) RailButton.Style.ACTIVE else RailButton.Style.NEUTRAL)
        railBubble.setBadge(if (canOverlay) 0 else 1, Palette.DANGER)
        renderBoardButtons()
    }

    private fun onSpeakers(speakers: List<Participant>) {
        val local = room?.localParticipant
        speakingId = null
        for (p in speakers) {
            if (p === local) continue
            val id = p.identity?.value ?: continue
            if (id.startsWith("teacher")) continue
            if (p.isMicrophoneEnabled) {
                stickySpeakers.add(id)
                if (speakingId == null) speakingId = id
            } else {
                stickySpeakers.remove(id)
            }
        }
        renderVideos()
    }

    /** Rolling rotation among students who are not pinned or speaking (8 s, as on the web). */
    private fun startRotation() {
        rotationJob?.cancel()
        rotationJob = lifecycleScope.launch {
            while (isActive) {
                delay(8000)
                // Nobody sees the tiles while the app is in the background.
                if (!appVisible) continue
                rotationOrder = ClassLogic.rotate(rotationOrder)
                renderVideos()
            }
        }
    }

    /**
     * Fill the video column: the teacher's own camera, then three students
     * (pinned → speaking → sticky speakers → rotation). Only the shown
     * students' cameras are subscribed, at the low simulcast layer; students
     * never see each other's video (server permissions).
     */
    private fun renderVideos() {
        if (!::tileGrid.isInitialized) return
        val r = room
        val self = tiles[0]
        self.bind(
            r,
            null,
            "You",
            if (cameraOn) cameraTrack else null,
            mirror = cameraPosition == CameraPosition.FRONT,
            emptyText = if (cameraOn) null else "Camera off",
        )
        val byIdentity = HashMap<String, io.livekit.android.room.participant.RemoteParticipant>()
        r?.remoteParticipants?.values?.forEach { p -> p.identity?.value?.let { byIdentity[it] = p } }
        // Drop sticky speakers who left or muted themselves.
        stickySpeakers.retainAll { id -> byIdentity[id]?.isMicrophoneEnabled == true }
        fun cameraPub(id: String) = byIdentity[id]?.getTrackPublication(Track.Source.CAMERA) as? RemoteTrackPublication
        val visibleSet = visibleIdentities.toSet()
        val pool = byIdentity.keys.filter { id ->
            !id.startsWith("teacher") && (visibleSet.isEmpty() || id in visibleSet) && cameraPub(id)?.muted == false
        }
        // Keep a stable rotation order; new publishers join at the end.
        rotationOrder = rotationOrder.filter { it in pool } + pool.filter { it !in rotationOrder }.shuffled()
        val spot = students.firstOrNull { it.id == spotlightId }?.identity
        val pins = listOfNotNull(spot) + ClassLogic.pinOrder(students).filter { it != spot }
        val shown = ClassLogic.pickTiles(pool, pins, speakingId, stickySpeakers, rotationOrder, ClassLogic.STUDENT_TILES)
        // Subscribe only to the shown cameras, at the lowest layer.
        for ((id, _) in byIdentity) {
            val pub = cameraPub(id) ?: continue
            // In the background (e.g. sharing another app) receive no student video.
            // Nor while the whiteboard covers the tiles.
            val want = appVisible && wbScreen?.visibility != View.VISIBLE && id in shown
            try {
                if (pub.subscribed != want) pub.setSubscribed(want)
                if (want) pub.setVideoQuality(VideoQuality.LOW)
            } catch (e: Exception) {
                android.util.Log.w(TAG, "subscribe $id", e)
            }
        }
        val studentCount = students.size
        for (i in 1 until tiles.size) {
            val id = shown.getOrNull(i - 1)
            val tile = tiles[i]
            if (id == null) {
                val text = when {
                    studentCount == 0 -> "No students yet"
                    i - 1 < minOf(studentCount, maxVisible) -> "Camera off"
                    else -> ""
                }
                tile.bind(r, null, "", null, emptyText = text)
                continue
            }
            val info = students.firstOrNull { it.identity == id }
            val p = byIdentity[id]
            val chip = when {
                info?.reconnecting == true -> "Reconnecting"
                id == spot -> "Spotlight"
                info?.handRaised == true -> "✋ Hand up"
                info?.focus == "away" -> "Switched away"
                info?.focus == "left" -> "Not fullscreen"
                else -> null
            }
            tile.bind(
                r,
                id,
                info?.name ?: p?.name ?: "Student",
                cameraPub(id)?.track as? VideoTrack,
                pinned = info?.pinned == true,
                speaking = id == speakingId || p?.isSpeaking == true,
                chip = chip,
            )
        }
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
        renderRail()
        showError(if (toolbarWanted) "Floating bubble on: shown while you share or use other apps." else "Floating bubble off.")
        updateToolbar()
    }

    private val toolbarListener = object : FloatingToolbar.Listener {
        override fun onBubbleTap() {
            // Back to the class; a running share pauses in onStart (the
            // capture stays granted, so resuming needs no new prompt).
            openAppWith(null)
        }

        override fun onToggleMic() {
            if (!hasPermission(Manifest.permission.RECORD_AUDIO)) return openAppWith("Allow the microphone here first.")
            toggleMic()
        }

        override fun onOpenApp() {
            keepSharingOnReturn = sharing && !sharePaused
            openAppWith(null)
        }

        override fun onStopShare() {
            lifecycleScope.launch { stopScreenShare() }
        }

        override fun onMaskToggle(on: Boolean) {
            maskProcessor.enabled = on
            renderToolbar()
        }

        override fun onAllowAllDraw() {
            val ids = students.filter { it.drawRequested && !it.drawing }.map { it.id }
            studentAction("Could not allow drawing") { c -> ids.forEach { c.draw(code, "allow", it) } }
        }

        override fun onClearDrawing() = studentAction("Could not clear the drawing") { it.draw(code, "clear") }

        override fun onStopDrawing() = studentAction("Could not stop the drawing") { it.draw(code, "revoke") }

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
        val want = toolbarWanted && Settings.canDrawOverlays(this) && inClass && ((sharing && !sharePaused) || !appVisible)
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
                sharing = sharing && !sharePaused,
                micOn = micOn,
                waiting = waitingList.size,
                hands = handsRaised,
                unreadChat = unreadChat,
                focusAlerts = focusAlerts,
                maskOn = maskProcessor.enabled,
                drawRequests = students.count { it.drawRequested && !it.drawing },
                drawing = students.count { it.drawing },
            ),
        )
    }

    private fun markChatSeen() {
        lastSeenChatId = chatIds.lastOrNull()
        unreadChat = 0
        renderToolbar()
        if (::railChat.isInitialized) renderRail()
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
                if ((e as? ApiException)?.status == 409) showError(Realtime.classFullMessage(e.message))
                else showError(e.message ?: "Could not admit students")
            }
        }
    }

    /** [to] = a student's participant id (private reply), null = everyone. */
    private fun sendChat(text: String, to: String? = null) {
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) { api?.sendMessage(code, text, to) }
                refreshChat()
                markChatSeen()
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
            .setMessage("Students are disconnected and the class closes. To step out but keep the class running, use Leave.")
            .setPositiveButton("End class") { _, _ -> lifecycleScope.launch { endClass() } }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private suspend fun endClass() {
        try {
            if (sharing) stopScreenShare()
            closeWhiteboard(clearSave = true)
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
            saveWhiteboardLocal() // the board stays on for the class; reopened from this copy on rejoin
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
        sharePaused = false
        stopInk()
        closeWhiteboardView()
        wbHost = null
        wbSaveJob?.cancel()
        wbStoreJob?.cancel()
        renderRail()
        updateToolbar()
        waitingList = emptyList()
        students = emptyList()
        rotationJob?.cancel()
        closePanel()
        chatIds = emptyList()
        chatMessages = emptyList()
        chatSince = null
        chatQuestion = null
        lastSeenChatId = null
        unreadChat = 0
    }

    private fun startPolling() {
        pollJob?.cancel()
        pollJob = lifecycleScope.launch {
            var tick = 0
            while (isActive) {
                // While LiveKit is connected the server pushes "state changed" and
                // chat packets, so the HTTP poll is only a safety net.
                val live = room?.state == Room.State.CONNECTED
                try {
                    if (!refreshState()) return@launch
                    renderConnection()
                    if (!live || chatDue || tick % 3 == 0) {
                        chatDue = false
                        refreshChat()
                    }
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
                tick++
                // 2 s while pushes cannot arrive (30 s in the background), a 60 s
                // safety net while they can (pushes wake it at once).
                withTimeoutOrNull(Realtime.pollMs(appVisible, fast = !live)) { pollWake.receive() }
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
        students = ClassLogic.parseStudents(state.optJSONArray("admitted"))
        handsRaised = students.count { it.handRaised }
        focusAlerts = students.count { it.focusAlert }
        maxVisible = state.optInt("maxVisibleVideos", ClassLogic.STUDENT_TILES).coerceIn(1, 6)
        waitingRoomOn = state.optBoolean("waitingRoomOn", true)
        val spot = state.optJSONObject("spotlight")
        spotlightId = spot?.optString("participantId")?.takeIf { it.isNotBlank() }
        spotlightName = spot?.optString("name")?.takeIf { it.isNotBlank() }
        micQueue = ClassLogic.parseMicQueue(state.optJSONArray("micQueue"))
        val now = System.currentTimeMillis()
        drawAllowed.entries.removeAll { it.value < now }
        wbServerOn = state.optBoolean("whiteboard")
        // The board is on for the class but not open here (app restarted): reopen it from the local copy.
        if (wbServerOn && wbHost == null && !wbClosing) openWhiteboard(fromServerState = true)
        val vis = state.optJSONArray("visibleIdentities") ?: JSONArray()
        visibleIdentities = (0 until vis.length()).map { vis.optString(it) }
        // Students muted by the teacher drop their sticky speaker slot.
        students.filter { it.muted }.forEach { stickySpeakers.remove(it.identity) }
        renderToolbar()
        renderRail()
        renderVideos()
        renderRosterPanel()
        return true
    }

    private fun renderWaiting(waiting: JSONArray) {
        val n = waiting.length()
        val first = if (n > 0) waiting.getJSONObject(0).optString("displayName", "A student") else ""
        if (n > knownWaiting && !lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
            notifyWaiting(if (n == 1) "$first is waiting to join" else "$n students are waiting to join")
        }
        knownWaiting = n
        binding.waitingBanner.visibility = if (n > 0) View.VISIBLE else View.GONE
        binding.waitingText.text = if (n == 1) "$first is waiting" else "$n students waiting"
        binding.admitAllButton.text = if (n == 1) "Admit" else "Admit all"
        binding.waitingBanner.contentDescription = "${binding.waitingText.text}. Tap to see the waiting room."
    }

    @SuppressLint("MissingPermission")
    private fun notifyWaiting(text: String) {
        if (needsNotificationPermission()) return
        getSystemService(NotificationManager::class.java).notify(Notifications.WAITING_ID, Notifications.waiting(this, text))
    }

    private suspend fun refreshChat() {
        val payload = withContext(Dispatchers.IO) { api?.messages(code, chatSince) } ?: return
        val freshArr = payload.optJSONArray("messages") ?: JSONArray()
        val fresh = (0 until freshArr.length()).mapNotNull { freshArr.optJSONObject(it) }
        // Only newer messages come back (5 s overlap): merge by id, keep the last 500.
        chatMessages = Realtime.mergeById(chatMessages, fresh, { m -> m.optString("id").ifBlank { "${m.optString("createdAt")}:${m.optString("body").hashCode()}" } })
        chatMessages.lastOrNull()?.optString("createdAt")?.takeIf { it.isNotBlank() }?.let { chatSince = it }
        if (fresh.isEmpty() && chatIds.isNotEmpty()) return
        // Private messages are marked ("private, to you" / "You → Ana (private)").
        chatText = chatMessages.joinToString("\n") { ChatLogic.line(it) }
        chatQuestion = ChatLogic.pendingPrivateQuestion(chatMessages)
        panel?.renderChat(chatText, chatQuestion)
        val ids = ArrayList<String>()
        chatMessages.forEachIndexed { i, m ->
            ids.add(m.optString("id").ifBlank { "$i:${m.optString("createdAt")}:${m.optString("body").hashCode()}" })
        }
        val recent = chatMessages.takeLast(4).map { ChatLogic.line(it) }
        chatIds = ids
        recentChat = recent
        if (appVisible && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) && panelKind == ClassPanel.Kind.CHAT) {
            markChatSeen()
        } else {
            val seen = lastSeenChatId
            val idx = if (seen == null) -1 else ids.lastIndexOf(seen)
            unreadChat = if (idx >= 0) ids.size - 1 - idx else if (seen == null) ids.size else minOf(ids.size, 9)
            renderToolbar()
            renderRail()
        }
    }

    private fun note(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(0xFFE2E8F0.toInt())
        textSize = 15f
        setPadding(0, 12, 0, 12)
    }

    private fun showOnly(group: View) {
        listOf(binding.loginGroup, binding.homeGroup, binding.handoffGroup)
            .forEach { it.visibility = if (it === group) View.VISIBLE else View.GONE }
        val inClass = group === binding.classScreen
        if (!inClass) closeWhiteboardView()
        binding.classScreen.visibility = if (inClass) View.VISIBLE else View.GONE
        binding.scroll.visibility = if (inClass) View.GONE else View.VISIBLE
        if (!inClass) closePanel()
        clearError()
    }

    private fun showError(message: String) {
        binding.errorText.text = message
        if (binding.classScreen.visibility == View.VISIBLE && message.isNotBlank()) showToast(message)
    }

    /** Short message over the class screen (errors, confirmations). */
    private fun showToast(message: String) {
        val t = binding.classToast
        t.text = message
        t.visibility = View.VISIBLE
        toastJob?.cancel()
        toastJob = lifecycleScope.launch {
            delay(4500)
            t.visibility = View.GONE
        }
    }

    private fun clearError() {
        binding.errorText.text = ""
    }

    // ---- Share pause / resume ---------------------------------------------
    //
    // The MediaProjection grant and the foreground service live as long as the
    // capture track, so pausing only drops frames (ScreenMaskProcessor.paused)
    // and mutes the publication: going back to the share never re-prompts.

    private fun onShareButton() {
        if (!sharing) return requestScreenShare()
        val items = if (sharePaused) arrayOf("Resume sharing", "Stop sharing") else arrayOf("Pause sharing (stay in the app)", "Stop sharing")
        AlertDialog.Builder(this)
            .setTitle(if (sharePaused) "Screen share paused" else "Sharing your screen")
            .setItems(items) { _, which ->
                lifecycleScope.launch {
                    when {
                        which == 1 -> stopScreenShare()
                        sharePaused -> resumeShare()
                        else -> pauseShare()
                    }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun screenPublication() = room?.localParticipant?.getTrackPublication(Track.Source.SCREEN_SHARE) as? LocalTrackPublication

    private suspend fun pauseShare() {
        if (!sharing || sharePaused) return
        sharePaused = true
        maskProcessor.paused = true
        try {
            screenPublication()?.muted = true
        } catch (e: Exception) {
            android.util.Log.w(TAG, "mute share", e)
        }
        stopInk()
        binding.classStatus.text = "Share paused · students see the class view"
        renderRail()
        updateToolbar()
        try {
            withContext(Dispatchers.IO) { api?.stage(code, "idle") }
        } catch (_: Exception) {
        }
    }

    private suspend fun resumeShare() {
        if (!sharing || !sharePaused) return
        sharePaused = false
        maskProcessor.paused = false
        try {
            screenPublication()?.muted = false
        } catch (e: Exception) {
            android.util.Log.w(TAG, "unmute share", e)
        }
        binding.classStatus.text = "Sharing this device's screen with the class"
        renderRail()
        moveTaskToBack(true)
        updateToolbar()
        startInk()
        try {
            withContext(Dispatchers.IO) { api?.stage(code, "screen", desktopInk = inkOverlay?.shown == true) }
        } catch (_: Exception) {
        }
    }

    // ---- Student ink on the share -------------------------------------------

    /** Show allowed students' ink over the shared screen (burned into the capture, so students fade their copy). */
    private fun startInk() {
        val o = inkOverlay ?: InkOverlay(applicationContext).also { inkOverlay = it }
        if (!o.available) return
        o.show()
        o.update(inkStrokes)
        val c = api ?: return
        val cc = code
        lifecycleScope.launch {
            try {
                val st = withContext(Dispatchers.IO) { c.drawState(cc) }
                inkStrokes = Realtime.parseInkStrokes(st.optJSONArray("strokes"))
                inkOverlay?.update(inkStrokes)
            } catch (_: Exception) {
            }
        }
    }

    private fun stopInk() {
        inkOverlay?.hide()
    }

    private fun canAllowDraw() = (sharing && !sharePaused) || wbHost != null

    private fun drawHolders(): Set<String> {
        val now = System.currentTimeMillis()
        return students.filter { it.drawing }.map { it.identity }.toSet() + drawAllowed.filterValues { it > now }.keys
    }

    /** Data packets: server pushes (no participant), student signals, ink and whiteboard packets. */
    private fun onData(sender: String?, topic: String?, data: ByteArray) {
        when (topic) {
            STATE_TOPIC -> if (sender == null) pollWake.trySend(Unit)
            CHAT_TOPIC -> if (sender == null) { chatDue = true; pollWake.trySend(Unit) }
            Realtime.SIGNAL_TOPIC -> {
                val s = Realtime.decodeSignal(data) ?: return
                if (!Realtime.signalTrusted(s, sender)) return
                if (s is Realtime.Signal.DrawAllow) {
                    if (s.on) drawAllowed[s.identity] = s.until else drawAllowed.remove(s.identity)
                }
                if (s is Realtime.Signal.DrawReq && s.on && appVisible) showToast("A student asks to draw")
                pollWake.trySend(Unit)
            }
            Realtime.DRAW_TOPIC -> {
                if (!sharing) return
                val o = try { JSONObject(String(data, Charsets.UTF_8)) } catch (_: Exception) { return }
                val p = Realtime.decodeInk(o) ?: return
                if (!Realtime.inkTrusted(p, sender)) return
                if (p is Realtime.Ink.Pts && sender != null && sender !in drawHolders()) return
                Realtime.applyInk(inkStrokes, p)
                inkOverlay?.update(inkStrokes)
            }
            Wb.TOPIC -> {
                val h = wbHost ?: return
                if (h.receive(data, sender, drawHolders())) {
                    wbScreen?.changed()
                    scheduleWbSave()
                }
            }
        }
    }

    /** Students see the teacher's camera panel only while the teacher is in the app and not on the board. */
    private fun syncVideoPanel() {
        val c = api ?: return
        if (room == null) return
        val want = appVisible && wbHost == null && !(sharing && !sharePaused)
        if (videoPanelSent == want) return
        videoPanelSent = want
        val cc = code
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) { c.videoPanel(cc, want) }
            } catch (_: Exception) {
                if (videoPanelSent == want) videoPanelSent = null
            }
        }
    }

    // ---- Whiteboard ---------------------------------------------------------

    private var wbClosing = false
    private fun wbFile() = java.io.File(filesDir, "whiteboard-${code.uppercase()}.json")

    private fun openWhiteboard(fromServerState: Boolean = false) {
        val r = room ?: return
        if (wbHost != null) return showWhiteboardView()
        val saved = try { wbFile().takeIf { it.exists() }?.readText() } catch (_: Exception) { null }
        val doc = WbHost.restore(saved) ?: Doc.empty()
        val host = WbHost(doc) { packets, to -> sendWb(r, packets, to) }
        wbHost = host
        wbSavedVersion = host.version
        wbStoredVersion = -1
        wbLastStore = 0L
        if (sharing && !sharePaused) lifecycleScope.launch { pauseShare() }
        showWhiteboardView()
        val c = api
        val cc = code
        lifecycleScope.launch {
            if (!fromServerState) {
                try {
                    withContext(Dispatchers.IO) { c?.whiteboard(cc, "on") }
                } catch (e: Exception) {
                    showError(e.message ?: "Could not open the whiteboard for the class")
                }
            }
            // Students may still be loading the board: send it a few times.
            for (d in longArrayOf(0, 500, 1000)) {
                delay(d)
                if (wbHost !== host) return@launch
                host.sendSnapshot()
            }
            storeWhiteboard(force = true)
        }
        syncVideoPanel()
        renderRail()
    }

    private fun showWhiteboardView() {
        val host = wbHost ?: return
        val screen = wbScreen ?: WhiteboardScreen(this, boardListener).also { wbScreen = it }
        screen.host = host
        screen.board.me = "teacher"
        // Laser pointer: lossy data on the board topic (a late laser point is useless).
        screen.board.onLaser = { pts -> room?.let { r -> sendWbLossy(r, WbCodec.laserPacket(pts)) } }
        if (screen.parent == null) {
            // Under the panels / toast so chat and the roster still open over the board.
            binding.classScreen.addView(screen, 1, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        screen.visibility = View.VISIBLE
        screen.setCompact(windowClass() == WindowClass.COMPACT)
        screen.changed()
        renderBoardButtons()
        renderVideos() // drops student video under the board
    }

    /** Remove the board view (the session itself ends in [closeWhiteboard]). */
    private fun closeWhiteboardView() {
        wbScreen?.let { (it.parent as? ViewGroup)?.removeView(it) }
        wbScreen = null
    }

    private fun closeWhiteboard(clearSave: Boolean) {
        val had = wbHost != null
        wbHost = null
        wbSaveJob?.cancel()
        wbStoreJob?.cancel()
        closeWhiteboardView()
        if (clearSave) try { wbFile().delete() } catch (_: Exception) {}
        if (had) {
            wbClosing = true
            val c = api
            val cc = code
            lifecycleScope.launch {
                try {
                    withContext(Dispatchers.IO) { c?.whiteboard(cc, "off") }
                } catch (_: Exception) {
                }
                wbClosing = false
            }
        }
        renderVideos()
        syncVideoPanel()
        renderRail()
    }

    private fun sendWbLossy(r: Room, packet: ByteArray) {
        lifecycleScope.launch {
            try {
                r.localParticipant.publishData(packet, DataPublishReliability.LOSSY, Wb.TOPIC)
            } catch (_: Exception) {
            }
        }
    }

    private fun sendWb(r: Room, packets: List<ByteArray>, to: List<String>?) {
        lifecycleScope.launch {
            for (b in packets) {
                try {
                    r.localParticipant.publishData(
                        b,
                        DataPublishReliability.RELIABLE,
                        Wb.TOPIC,
                        to?.map { Participant.Identity(it) } ?: emptyList(),
                    )
                } catch (e: Exception) {
                    android.util.Log.w(TAG, "wb send", e)
                }
            }
        }
    }

    /** Local copy debounced 3 s; server copy at most every 5 s (late joiners, other devices). */
    private fun scheduleWbSave() {
        val h = wbHost ?: return
        if (h.version == wbSavedVersion && h.version == wbStoredVersion) return
        if (wbSaveJob?.isActive != true) {
            wbSaveJob = lifecycleScope.launch {
                delay(3000)
                saveWhiteboardLocal()
            }
        }
        if (wbStoreJob?.isActive != true) {
            wbStoreJob = lifecycleScope.launch {
                delay(maxOf(0L, 5000L - (System.currentTimeMillis() - wbLastStore)))
                storeWhiteboard(force = false)
            }
        }
    }

    private suspend fun saveWhiteboardLocal() {
        val h = wbHost ?: return
        if (h.version == wbSavedVersion) return
        val v = h.version
        val json = h.doc.toJson().toString()
        val f = wbFile()
        withContext(Dispatchers.IO) {
            try {
                val tmp = java.io.File(f.parentFile, f.name + ".tmp")
                tmp.writeText(json)
                tmp.renameTo(f)
            } catch (e: Exception) {
                android.util.Log.w(TAG, "wb save", e)
            }
        }
        wbSavedVersion = v
    }

    private fun flushWhiteboardSave() {
        if (wbHost == null) return
        lifecycleScope.launch { saveWhiteboardLocal() }
    }

    private suspend fun storeWhiteboard(force: Boolean) {
        val h = wbHost ?: return
        if (!force && h.version == wbStoredVersion) return
        val v = h.version
        val packets = withContext(Dispatchers.Default) { WbHost.storable(h.snapshotPackets()) }
        wbLastStore = System.currentTimeMillis()
        if (packets == null) return // too big for the server copy; students still get live snapshots
        try {
            withContext(Dispatchers.IO) { api?.whiteboard(code, "snap", packets) }
            wbStoredVersion = v
        } catch (_: Exception) {
        }
    }

    private fun renderBoardButtons() {
        val s = wbScreen ?: return
        s.micButton.setIcon(if (micOn) R.drawable.ic_mic else R.drawable.ic_mic_off)
        s.micButton.setStyle(if (micOn) RailButton.Style.ON else RailButton.Style.OFF_WARN)
        s.micButton.label = if (micOn) "Microphone on. Tap to mute" else "Microphone off. Tap to speak"
        s.chatButton.setBadge(unreadChat, 0xFF3B82F6.toInt())
        s.rosterButton.setBadge(waitingList.size + handsRaised + students.count { it.drawRequested && !it.drawing })
    }

    private val boardListener = object : WhiteboardScreen.Listener {
        override fun onCloseBoard() {
            AlertDialog.Builder(this@MainActivity)
                .setTitle("Close the whiteboard?")
                .setMessage("Students go back to the class view. The board is not kept after you close it.")
                .setPositiveButton("Close board") { _, _ -> closeWhiteboard(clearSave = true) }
                .setNeutralButton("Hide (keep it open)") { _, _ ->
                    wbScreen?.visibility = View.GONE
                    renderVideos()
                }
                .setNegativeButton("Cancel", null)
                .show()
        }
        override fun onBoardMic() = ensureMicThenToggle()
        override fun onBoardChat() = togglePanel(ClassPanel.Kind.CHAT)
        override fun onBoardRoster() = togglePanel(ClassPanel.Kind.ROSTER)
        override fun onBoardText(x: Int, y: Int) {
            val host = wbHost ?: return
            val input = android.widget.EditText(this@MainActivity).apply { hint = "Text"; maxLines = 4 }
            AlertDialog.Builder(this@MainActivity)
                .setTitle("Add text")
                .setView(input)
                .setPositiveButton("Add") { _, _ ->
                    val t = input.text.toString().trim().take(500)
                    if (t.isEmpty()) return@setPositiveButton
                    val pg = host.doc.pages[host.doc.cur]
                    val size = WbStyle.textSize(wbScreen?.board?.penWidth ?: 4)
                    host.local(listOf(WbOps.add(pg.id, Item.Text(Wb.newId("t"), "teacher", wbScreen?.board?.color ?: "#111111", size, x, y, t))))
                    wbScreen?.changed()
                    scheduleWbSave()
                }
                .setNegativeButton("Cancel", null)
                .show()
        }
        override fun onBoardChanged() = scheduleWbSave()
        override fun onBoardInsertImage() {
            try {
                boardImagePicker.launch("image/*")
            } catch (_: Exception) {
                showError("No app on this device can pick a picture.")
            }
        }
        override fun onBoardExport(pdf: Boolean) {
            val host = wbHost ?: return
            val board = wbScreen?.board ?: return
            lifecycleScope.launch {
                try {
                    val pages = if (pdf) host.doc.pages.toList() else listOf(host.doc.currentPage())
                    val bitmaps = pages.map { board.renderPage(it) }
                    val uri = withContext(Dispatchers.IO) { WbFiles.export(this@MainActivity, bitmaps, pdf, host.doc.cur + 1) }
                    bitmaps.forEach { it.recycle() }
                    startActivity(Intent.createChooser(WbFiles.shareIntent(uri, pdf), if (pdf) "Share the whiteboard PDF" else "Share the whiteboard page"))
                } catch (e: Exception) {
                    showError(e.message ?: "Could not export the whiteboard")
                }
            }
        }
    }

    // ---- Window size classes (Material: compact < 600dp ≤ medium < 840dp ≤ expanded) ----

    private enum class WindowClass { COMPACT, MEDIUM, EXPANDED }

    private fun windowClass(): WindowClass = ClassLogic.windowClass(resources.configuration.screenWidthDp).let {
        when (it) { 0 -> WindowClass.COMPACT; 1 -> WindowClass.MEDIUM; else -> WindowClass.EXPANDED }
    }

    // ---- Crash reports ------------------------------------------------------

    /** Uncaught exceptions go to /api/client-error (scrubbed, ≤ 5 a minute, each once), then to the default handler. */
    private fun installCrashReporter() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        if (previous is CrashHandler) return
        Thread.setDefaultUncaughtExceptionHandler(CrashHandler(previous))
    }

    private inner class CrashHandler(private val previous: Thread.UncaughtExceptionHandler?) : Thread.UncaughtExceptionHandler {
        override fun uncaughtException(t: Thread, e: Throwable) {
            try { reportError(e, wait = true) } catch (_: Throwable) {}
            previous?.uncaughtException(t, e)
        }
    }

    private fun reportError(e: Throwable, wait: Boolean = false) {
        val c = api ?: return
        val key = e.javaClass.name + ":" + (e.stackTrace.firstOrNull()?.toString() ?: "")
        if (!errorReporter.admit(key)) return
        val ua = "ClassroomTeacher-Android/${BuildConfig.VERSION_NAME} (Android ${android.os.Build.VERSION.RELEASE}; SDK ${android.os.Build.VERSION.SDK_INT}; ${android.os.Build.MODEL})"
        val body = ErrorReporter.payload(e, code, "android://teacher/${if (room != null) "class" else "home"}", ua)
        // Never network on the crashing (possibly main) thread; wait briefly so the report leaves before the process dies.
        val th = Thread { try { c.clientError(body) } catch (_: Exception) {} }
        th.start()
        if (wait) th.join(2500)
    }


    companion object {
        private const val TAG = "ClassroomTeacher"
        /** LiveKit data topics sent by the web server (see apps/web lib/pollPolicy.ts, Chat.tsx). */
        private const val STATE_TOPIC = "cls-state"
        private const val CHAT_TOPIC = "chat"
        /** Session renewal interval (the server's idle limit is 24 h). */
        private const val RENEW_MS = 30 * 60_000L
        private const val PREFS = "classroom_teacher"
        private const val KEY_SERVER = "server"
        private const val KEY_EMAIL = "email"
        private const val KEY_NAME = "name"
        private const val KEY_COOKIE = "session"
        private const val KEY_VOICE_FOCUS = "voice_focus"
        const val EXTRA_STOP_SHARE = "stop_share"
    }
}
