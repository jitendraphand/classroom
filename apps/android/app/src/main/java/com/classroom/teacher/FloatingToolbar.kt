package com.classroom.teacher

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.provider.Settings
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.google.android.material.button.MaterialButton
import kotlin.math.abs

/** What the floating toolbar shows; rebuilt from each room-state poll. */
data class ToolbarState(
    val sharing: Boolean = false,
    val micOn: Boolean = false,
    val cameraOn: Boolean = false,
    val waiting: List<Pair<String, String>> = emptyList(),
    val hands: Int = 0,
    val focusAlerts: Int = 0,
    val unreadChat: Int = 0,
    val recentChat: List<String> = emptyList(),
    val maskOn: Boolean = true,
)

/**
 * "Display over other apps" toolbar for screen sharing: a small draggable pill
 * with badges (chat, hands, waiting, not-fullscreen) that expands into a panel
 * with the class controls. Its on-screen rectangle is reported on every
 * layout / drag so [ScreenMaskProcessor] can black it out of the share.
 */
class FloatingToolbar(private val context: Context, private val listener: Listener) {
    interface Listener {
        fun onToggleMic()
        fun onToggleCamera()
        fun onAdmitAll()
        fun onAdmit(participantId: String)
        fun onMuteAll()
        fun onSendChat(text: String)
        fun onStopShare()
        fun onOpenApp()
        fun onMaskToggle(on: Boolean)
        fun onExpandedChanged(expanded: Boolean)
        /** Screen rect of the toolbar window (display px), or null when it is gone. */
        fun onRectChanged(rect: IntRect?)
    }

    private val wm = context.getSystemService(WindowManager::class.java)
    private val density = context.resources.displayMetrics.density
    private fun dp(v: Int) = (v * density).toInt()

    private var root: LinearLayout? = null
    private var params: WindowManager.LayoutParams? = null
    private var expanded = false
    private var state = ToolbarState()

    private lateinit var pill: TextView
    private lateinit var panel: LinearLayout
    private lateinit var waitingBox: LinearLayout
    private lateinit var chatBox: TextView
    private lateinit var replyInput: EditText
    private lateinit var micBtn: MaterialButton
    private lateinit var camBtn: MaterialButton
    private lateinit var stopShareBtn: MaterialButton
    private lateinit var maskBtn: MaterialButton

    val isShowing: Boolean get() = root != null

    fun canShow(): Boolean = Settings.canDrawOverlays(context)

    fun show() {
        if (root != null || !canShow()) return
        val view = build()
        val p = WindowManager.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            } else {
                @Suppress("DEPRECATION")
                WindowManager.LayoutParams.TYPE_PHONE
            },
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = dp(12)
            y = context.resources.displayMetrics.heightPixels / 3
        }
        try {
            wm.addView(view, p)
        } catch (e: Exception) {
            android.util.Log.w("FloatingToolbar", "addView", e)
            return
        }
        root = view
        params = p
        reportEstimate()
        view.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> reportRect() }
        render(state)
    }

    fun hide() {
        val v = root ?: return
        root = null
        params = null
        expanded = false
        try {
            wm.removeView(v)
        } catch (_: Exception) {
        }
        listener.onRectChanged(null)
    }

    fun render(s: ToolbarState) {
        state = s
        if (root == null) return
        val badges = buildList {
            if (s.unreadChat > 0) add("💬${s.unreadChat}")
            if (s.hands > 0) add("✋${s.hands}")
            if (s.waiting.isNotEmpty()) add("⏳${s.waiting.size}")
            if (s.focusAlerts > 0) add("⚠${s.focusAlerts}")
        }
        val dot = if (s.sharing) "● " else "○ "
        pill.text = dot + if (badges.isEmpty()) "Class" else badges.joinToString("  ")
        micBtn.text = if (s.micOn) "Mic off" else "Mic on"
        camBtn.text = if (s.cameraOn) "Camera off" else "Camera on"
        stopShareBtn.visibility = if (s.sharing) View.VISIBLE else View.GONE
        maskBtn.visibility = if (s.sharing) View.VISIBLE else View.GONE
        maskBtn.text = if (s.maskOn) "Hide panel from share: on" else "Hide panel from share: off"
        waitingBox.removeAllViews()
        if (s.waiting.isNotEmpty()) {
            waitingBox.addView(label("Waiting (${s.waiting.size})", bold = true))
            for ((id, name) in s.waiting.take(6)) {
                val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
                row.addView(label(name).apply { layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f) })
                row.addView(smallButton("Admit") { listener.onAdmit(id) })
                waitingBox.addView(row)
            }
            if (s.waiting.size > 1) waitingBox.addView(smallButton("Admit all (${s.waiting.size})") { listener.onAdmitAll() })
        }
        chatBox.text = s.recentChat.takeLast(4).joinToString("\n").ifBlank { "No messages yet." }
        if (s.hands > 0 || s.focusAlerts > 0) {
            val extra = buildList {
                if (s.hands > 0) add("${s.hands} hand${if (s.hands == 1) "" else "s"} raised")
                if (s.focusAlerts > 0) add("${s.focusAlerts} not in fullscreen")
            }.joinToString(" · ")
            waitingBox.addView(label(extra))
        }
        root?.post { reportRect() }
    }

    /** After a rotation / resize, pull the window back inside the display. */
    fun keepOnScreen() {
        val v = root ?: return
        val p = params ?: return
        val dm = context.resources.displayMetrics
        p.x = p.x.coerceIn(0, maxOf(0, dm.widthPixels - v.width))
        p.y = p.y.coerceIn(0, maxOf(0, dm.heightPixels - v.height))
        try {
            wm.updateViewLayout(v, p)
        } catch (_: Exception) {
        }
        v.post { reportRect() }
    }

    /**
     * Conservative rect for a window that has not been laid out yet (just
     * added, or the panel is opening), so no frame shows it unmasked.
     */
    private fun reportEstimate() {
        val p = params ?: return
        val dm = context.resources.displayMetrics
        val w = dp(320)
        val h = if (expanded) (dm.heightPixels * 0.6).toInt() + dp(140) else dp(72)
        val currentW = root?.width ?: 0
        val currentH = root?.height ?: 0
        listener.onRectChanged(IntRect(p.x, p.y, p.x + maxOf(w, currentW), p.y + maxOf(h, currentH)))
    }

    private fun reportRect() {
        val v = root ?: return listener.onRectChanged(null)
        if (v.width == 0 || v.height == 0) return
        val loc = IntArray(2)
        v.getLocationOnScreen(loc)
        listener.onRectChanged(IntRect(loc[0], loc[1], loc[0] + v.width, loc[1] + v.height))
    }

    private fun setExpanded(on: Boolean) {
        expanded = on
        // Mask generously before the bigger window is first composited; the
        // exact rect follows after layout.
        if (on) reportEstimate()
        panel.visibility = if (on) View.VISIBLE else View.GONE
        val p = params ?: return
        // The reply box needs keyboard focus only while the panel is open.
        p.flags = if (on) {
            p.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv()
        } else {
            p.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        }
        root?.let { wm.updateViewLayout(it, p) }
        listener.onExpandedChanged(on)
        root?.post { reportRect() }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun build(): LinearLayout {
        val box = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = dp(16).toFloat()
                setColor(0xF20F172A.toInt())
                setStroke(dp(1), 0xFF334155.toInt())
            }
            setPadding(dp(6), dp(6), dp(6), dp(6))
        }
        pill = TextView(context).apply {
            setTextColor(0xFFF8FAFC.toInt())
            textSize = 15f
            setPadding(dp(12), dp(8), dp(12), dp(8))
            minHeight = dp(40)
            gravity = Gravity.CENTER_VERTICAL
            contentDescription = "Class controls. Tap to open, drag to move."
        }
        box.addView(pill)
        attachDrag(pill) { setExpanded(!expanded) }

        panel = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setPadding(dp(6), dp(4), dp(6), dp(6))
        }
        val content = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        val scroll = MaxHeightScrollView(context, (context.resources.displayMetrics.heightPixels * 0.6).toInt()).apply {
            addView(content)
        }
        panel.addView(scroll, LinearLayout.LayoutParams(dp(280), ViewGroup.LayoutParams.WRAP_CONTENT))

        val row1 = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        micBtn = smallButton("Mic on") { listener.onToggleMic() }
        camBtn = smallButton("Camera on") { listener.onToggleCamera() }
        row1.addView(micBtn, weighted())
        row1.addView(camBtn, weighted())
        content.addView(row1)
        content.addView(smallButton("Mute all students") { listener.onMuteAll() })

        waitingBox = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(4), 0, dp(4)) }
        content.addView(waitingBox)

        content.addView(label("Chat", bold = true))
        chatBox = label("").apply {
            setBackgroundColor(0xFF111827.toInt())
            setPadding(dp(8), dp(6), dp(8), dp(6))
            maxLines = 8
            ellipsize = TextUtils.TruncateAt.END
        }
        content.addView(chatBox)
        val replyRow = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        replyInput = EditText(context).apply {
            hint = "Reply to everyone"
            setTextColor(0xFFF8FAFC.toInt())
            setHintTextColor(0xFF64748B.toInt())
            textSize = 14f
            isSingleLine = true
            imeOptions = EditorInfo.IME_ACTION_SEND
            setOnEditorActionListener { _, action, _ ->
                if (action == EditorInfo.IME_ACTION_SEND) { sendReply(); true } else false
            }
        }
        replyRow.addView(replyInput, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        replyRow.addView(smallButton("Send") { sendReply() })
        content.addView(replyRow)

        stopShareBtn = smallButton("Stop sharing") { listener.onStopShare() }.apply {
            backgroundTintList = android.content.res.ColorStateList.valueOf(0xFFB91C1C.toInt())
        }
        content.addView(stopShareBtn)
        maskBtn = smallButton("Hide panel from share: on") { listener.onMaskToggle(!state.maskOn) }
        content.addView(maskBtn)
        val row2 = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        row2.addView(smallButton("Open app") { listener.onOpenApp() }, weighted())
        row2.addView(smallButton("Collapse") { setExpanded(false) }, weighted())
        content.addView(row2)
        box.addView(panel)
        return box
    }

    private fun sendReply() {
        val text = replyInput.text.toString().trim()
        if (text.isEmpty()) return
        listener.onSendChat(text)
        replyInput.setText("")
    }

    /** Drag the window by [handle]; a tap without movement runs [onTap]. */
    @SuppressLint("ClickableViewAccessibility")
    private fun attachDrag(handle: View, onTap: () -> Unit) {
        val slop = ViewConfiguration.get(context).scaledTouchSlop
        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        var dragging = false
        handle.setOnTouchListener { _, e ->
            val p = params ?: return@setOnTouchListener false
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; startX = p.x; startY = p.y; dragging = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX
                    val dy = e.rawY - downY
                    if (!dragging && (abs(dx) > slop || abs(dy) > slop)) dragging = true
                    if (dragging) {
                        val dm = context.resources.displayMetrics
                        val v = root
                        p.x = (startX + dx.toInt()).coerceIn(0, maxOf(0, dm.widthPixels - (v?.width ?: 0)))
                        p.y = (startY + dy.toInt()).coerceIn(0, maxOf(0, dm.heightPixels - (v?.height ?: 0)))
                        v?.let { wm.updateViewLayout(it, p) }
                        reportRect()
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!dragging) onTap() else root?.post { reportRect() }
                    true
                }
                else -> false
            }
        }
    }

    private fun weighted() = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)

    private fun label(text: String, bold: Boolean = false) = TextView(context).apply {
        this.text = text
        setTextColor(0xFFE2E8F0.toInt())
        textSize = 13f
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        setPadding(dp(2), dp(4), dp(2), dp(2))
    }

    private fun smallButton(text: String, onClick: () -> Unit) = MaterialButton(context).apply {
        this.text = text
        isAllCaps = false
        textSize = 13f
        minHeight = dp(40)
        setOnClickListener { onClick() }
    }

    /** ScrollView that stops growing at [maxHeightPx] (the panel must fit small screens). */
    private class MaxHeightScrollView(context: Context, private val maxHeightPx: Int) : ScrollView(context) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            super.onMeasure(widthMeasureSpec, View.MeasureSpec.makeMeasureSpec(maxHeightPx, View.MeasureSpec.AT_MOST))
        }
    }
}
