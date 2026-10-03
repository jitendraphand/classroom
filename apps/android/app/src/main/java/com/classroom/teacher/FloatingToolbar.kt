package com.classroom.teacher

import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.google.android.material.button.MaterialButton
import kotlin.math.abs

/** What the bubble shows; rebuilt from each room-state poll. */
data class ToolbarState(
    val sharing: Boolean = false,
    val micOn: Boolean = false,
    val waiting: Int = 0,
    val hands: Int = 0,
    val unreadChat: Int = 0,
    val focusAlerts: Int = 0,
    /** Black box over the bubble in the share (off for an Android 14 single-app share). */
    val maskOn: Boolean = true,
)

/**
 * "Display over other apps" bubble while the app is minimised (screen share
 * or teaching from another app): a small draggable pill with badges for the
 * waiting room, raised hands, new chat and not-fullscreen students, with a
 * short pulse whenever one of them goes up.
 *
 * Tap: back to the app (and, while sharing, stop the share).
 * Long-press: a mini menu (mic, open app and keep sharing, stop sharing).
 *
 * Its on-screen rect is reported on every layout / drag so
 * [ScreenMaskProcessor] blacks it out of the share.
 */
class FloatingToolbar(private val context: Context, private val listener: Listener) {
    interface Listener {
        /** Tap: reopen the app; stop the share if one is running. */
        fun onBubbleTap()
        fun onToggleMic()
        /** Mini menu: open the app but keep sharing. */
        fun onOpenApp()
        fun onStopShare()
        fun onMaskToggle(on: Boolean)
        /** Screen rect of the bubble window (display px), or null when it is gone. */
        fun onRectChanged(rect: IntRect?)
    }

    private val wm = context.getSystemService(WindowManager::class.java)
    private val density = context.resources.displayMetrics.density
    private fun dp(v: Int) = (v * density).toInt()

    private var root: LinearLayout? = null
    private var params: WindowManager.LayoutParams? = null
    private var menuOpen = false
    private var state = ToolbarState()

    private lateinit var pill: LinearLayout
    private lateinit var icon: ImageView
    private lateinit var badgeRow: LinearLayout
    private lateinit var menu: LinearLayout
    private lateinit var micBtn: MaterialButton
    private lateinit var stopBtn: MaterialButton
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
            x = context.resources.displayMetrics.widthPixels - dp(120)
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
        render(state, pulse = false)
    }

    fun hide() {
        val v = root ?: return
        root = null
        params = null
        menuOpen = false
        try {
            wm.removeView(v)
        } catch (_: Exception) {
        }
        listener.onRectChanged(null)
    }

    fun render(s: ToolbarState, pulse: Boolean = true) {
        val prev = state
        state = s
        if (root == null) return
        icon.setImageResource(if (s.sharing) R.drawable.ic_screen_share else R.drawable.ic_group)
        icon.imageTintList = ColorStateList.valueOf(if (s.sharing) 0xFFFCA5A5.toInt() else Color.WHITE)
        badgeRow.removeAllViews()
        addBadge(R.drawable.ic_group, s.waiting, Palette.AMBER, "waiting")
        addBadge(R.drawable.ic_hand, s.hands, Palette.AMBER, "raised hands")
        addBadge(R.drawable.ic_chat, s.unreadChat, 0xFF3B82F6.toInt(), "new messages")
        addBadge(R.drawable.ic_bubble, s.focusAlerts, 0xFFF97316.toInt(), "not in fullscreen")
        badgeRow.visibility = if (badgeRow.childCount > 0) View.VISIBLE else View.GONE
        val parts = buildList {
            if (s.waiting > 0) add("${s.waiting} waiting")
            if (s.hands > 0) add("${s.hands} hands raised")
            if (s.unreadChat > 0) add("${s.unreadChat} new messages")
            if (s.focusAlerts > 0) add("${s.focusAlerts} not in fullscreen")
        }
        pill.contentDescription = (if (s.sharing) "Sharing. Tap to stop and return to the class" else "Tap to return to the class") +
            (if (parts.isEmpty()) "" else ". " + parts.joinToString(", ")) + ". Long-press for more."
        micBtn.text = if (s.micOn) "Mic off" else "Mic on"
        stopBtn.visibility = if (s.sharing) View.VISIBLE else View.GONE
        maskBtn.visibility = if (s.sharing) View.VISIBLE else View.GONE
        maskBtn.text = if (s.maskOn) "Hide bubble in share: on" else "Hide bubble in share: off"
        if (pulse && (s.waiting > prev.waiting || s.hands > prev.hands || s.unreadChat > prev.unreadChat || s.focusAlerts > prev.focusAlerts)) {
            pulse()
        }
        root?.post { reportRect() }
    }

    private fun addBadge(iconRes: Int, count: Int, color: Int, what: String) {
        if (count <= 0) return
        val b = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), dp(2), dp(7), dp(2))
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(color)
            }
            contentDescription = "$count $what"
        }
        b.addView(ImageView(context).apply {
            setImageResource(iconRes)
            imageTintList = ColorStateList.valueOf(Color.BLACK)
        }, LinearLayout.LayoutParams(dp(13), dp(13)).apply { marginEnd = dp(3) })
        b.addView(TextView(context).apply {
            text = if (count > 99) "99+" else count.toString()
            setTextColor(Color.BLACK)
            textSize = 12f
            setTypeface(typeface, Typeface.BOLD)
        })
        badgeRow.addView(b, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            marginStart = dp(4)
        })
    }

    private fun pulse() {
        val v = pill
        ObjectAnimator.ofPropertyValuesHolder(
            v,
            PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 1.18f, 1f),
            PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 1.18f, 1f),
        ).apply {
            duration = 420
            repeatCount = 1
            start()
        }
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
     * added, or the menu is opening), so no frame shows it unmasked. The pulse
     * scales the pill by up to 18 %, which the margin covers.
     */
    private fun reportEstimate() {
        val p = params ?: return
        val w = dp(if (menuOpen) 220 else 200)
        val h = if (menuOpen) dp(260) else dp(64)
        listener.onRectChanged(IntRect(p.x, p.y, p.x + maxOf(w, root?.width ?: 0), p.y + maxOf(h, root?.height ?: 0)))
    }

    private fun reportRect() {
        val v = root ?: return listener.onRectChanged(null)
        if (v.width == 0 || v.height == 0) return
        val loc = IntArray(2)
        v.getLocationOnScreen(loc)
        // Grow by the pulse overshoot (scale 1.18 around the pill centre).
        val growX = (pill.width * 0.1f).toInt()
        val growY = (pill.height * 0.1f).toInt()
        listener.onRectChanged(IntRect(loc[0] - growX, loc[1] - growY, loc[0] + v.width + growX, loc[1] + v.height + growY))
    }

    private fun setMenu(on: Boolean) {
        menuOpen = on
        if (on) reportEstimate()
        menu.visibility = if (on) View.VISIBLE else View.GONE
        root?.post { reportRect() }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun build(): LinearLayout {
        val box = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(4), dp(4), dp(4), dp(4))
        }
        pill = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(52)
            setPadding(dp(12), dp(8), dp(12), dp(8))
            background = GradientDrawable().apply {
                cornerRadius = dp(26).toFloat()
                setColor(0xF20F172A.toInt())
                setStroke(dp(2), 0xFF3B82F6.toInt())
            }
            elevation = dp(6).toFloat()
        }
        icon = ImageView(context)
        pill.addView(icon, LinearLayout.LayoutParams(dp(26), dp(26)))
        badgeRow = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        pill.addView(badgeRow)
        box.addView(pill, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        attachGestures(pill)

        menu = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setPadding(dp(8), dp(8), dp(8), dp(8))
            background = GradientDrawable().apply {
                cornerRadius = dp(16).toFloat()
                setColor(0xF2111827.toInt())
                setStroke(dp(1), Palette.BORDER)
            }
        }
        micBtn = menuButton("Mic on") { listener.onToggleMic() }
        menu.addView(micBtn)
        menu.addView(menuButton("Open app (keep sharing)") { setMenu(false); listener.onOpenApp() })
        stopBtn = menuButton("Stop sharing") { setMenu(false); listener.onStopShare() }.apply {
            backgroundTintList = ColorStateList.valueOf(Palette.DANGER)
        }
        menu.addView(stopBtn)
        maskBtn = menuButton("Hide bubble in share: on") { listener.onMaskToggle(!state.maskOn) }.apply {
            backgroundTintList = ColorStateList.valueOf(Palette.SURFACE_2)
        }
        menu.addView(maskBtn)
        menu.addView(menuButton("Close menu") { setMenu(false) }.apply {
            backgroundTintList = ColorStateList.valueOf(Palette.SURFACE_2)
        })
        box.addView(menu, LinearLayout.LayoutParams(dp(212), ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
        return box
    }

    /** Drag anywhere; a tap without movement runs onBubbleTap; a long press opens the menu. */
    @SuppressLint("ClickableViewAccessibility")
    private fun attachGestures(handle: View) {
        val slop = ViewConfiguration.get(context).scaledTouchSlop
        val longPressMs = ViewConfiguration.getLongPressTimeout().toLong()
        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        var dragging = false
        var longPressed = false
        val longPress = Runnable {
            if (!dragging) {
                longPressed = true
                handle.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
                setMenu(!menuOpen)
            }
        }
        handle.setOnTouchListener { _, e ->
            val p = params ?: return@setOnTouchListener false
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; startX = p.x; startY = p.y
                    dragging = false; longPressed = false
                    handle.postDelayed(longPress, longPressMs)
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX
                    val dy = e.rawY - downY
                    if (!dragging && (abs(dx) > slop || abs(dy) > slop)) {
                        dragging = true
                        handle.removeCallbacks(longPress)
                    }
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
                    handle.removeCallbacks(longPress)
                    when {
                        dragging -> root?.post { reportRect() }
                        longPressed -> Unit
                        menuOpen -> setMenu(false)
                        else -> {
                            handle.performClick()
                            listener.onBubbleTap()
                        }
                    }
                    true
                }
                MotionEvent.ACTION_CANCEL -> {
                    handle.removeCallbacks(longPress)
                    true
                }
                else -> false
            }
        }
        // TalkBack: double-tap = tap, and a long-press action for the menu.
        handle.setOnLongClickListener { setMenu(!menuOpen); true }
    }

    private fun menuButton(text: String, onClick: () -> Unit) = MaterialButton(context).apply {
        this.text = text
        isAllCaps = false
        textSize = 14f
        minHeight = dp(44)
        setOnClickListener { onClick() }
    }
}
