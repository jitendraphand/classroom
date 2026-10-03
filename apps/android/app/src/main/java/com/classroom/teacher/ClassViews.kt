package com.classroom.teacher

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.widget.TooltipCompat
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
import livekit.org.webrtc.RendererCommon
import kotlin.math.ceil
import kotlin.math.min

/** Palette shared by the class screen (dark slate, as on the web). */
object Palette {
    const val BG = 0xFF0F172A.toInt()
    const val SURFACE = 0xFF1E293B.toInt()
    const val SURFACE_2 = 0xFF273449.toInt()
    const val BORDER = 0xFF334155.toInt()
    const val TEXT = 0xFFF8FAFC.toInt()
    const val MUTED = 0xFF94A3B8.toInt()
    const val BRAND = 0xFF2563EB.toInt()
    const val ON = 0xFF16A34A.toInt()
    const val DANGER = 0xFFDC2626.toInt()
    const val AMBER = 0xFFF59E0B.toInt()
    const val RIPPLE = 0x33FFFFFF
}

private fun Context.dp(v: Int) = (v * resources.displayMetrics.density).toInt()

/**
 * Icon-only rail control: 48dp+ touch target, icon tinted by state, optional
 * count badge, content description + long-press tooltip for the label.
 *
 * Styles: NEUTRAL (off / plain action), ON (feature running, green), ACTIVE
 * (panel open, blue), ALERT (off but needs attention, e.g. mic off is shown
 * neutral; sharing on is red-tinted via DANGER), DANGER (End class).
 */
class RailButton(context: Context) : FrameLayout(context) {
    enum class Style { NEUTRAL, ON, ACTIVE, OFF_WARN, DANGER }

    private val icon = ImageView(context)
    private val badge = TextView(context)
    private var style = Style.NEUTRAL
    var label: String = ""
        set(value) {
            field = value
            contentDescription = value
            TooltipCompat.setTooltipText(this, value)
        }

    init {
        isClickable = true
        isFocusable = true
        val size = context.dp(48)
        icon.layoutParams = LayoutParams(context.dp(24), context.dp(24), Gravity.CENTER)
        addView(icon)
        badge.apply {
            layoutParams = LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(18), Gravity.TOP or Gravity.END).apply {
                topMargin = context.dp(2)
                marginEnd = context.dp(2)
            }
            minWidth = context.dp(18)
            gravity = Gravity.CENTER
            setPadding(context.dp(4), 0, context.dp(4), 0)
            setTextColor(Color.WHITE)
            textSize = 10f
            setTypeface(typeface, Typeface.BOLD)
            background = GradientDrawable().apply {
                cornerRadius = context.dp(9).toFloat()
                setColor(Palette.AMBER)
            }
            visibility = View.GONE
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        addView(badge)
        minimumWidth = size
        minimumHeight = size
        applyStyle()
    }

    fun setIcon(res: Int) = icon.setImageResource(res)

    fun setStyle(s: Style) {
        if (s == style) return
        style = s
        applyStyle()
    }

    /** Count badge (hidden at 0); [color] e.g. amber for waiting / hands, brand for chat. */
    fun setBadge(count: Int, color: Int = Palette.AMBER) {
        if (count <= 0) {
            badge.visibility = View.GONE
        } else {
            badge.visibility = View.VISIBLE
            badge.text = if (count > 99) "99+" else count.toString()
            (badge.background as GradientDrawable).setColor(color)
        }
        contentDescription = if (count > 0) "$label, $count new" else label
    }

    override fun setEnabled(enabled: Boolean) {
        super.setEnabled(enabled)
        alpha = if (enabled) 1f else 0.38f
    }

    private fun applyStyle() {
        val (bg, fg) = when (style) {
            Style.NEUTRAL -> Palette.SURFACE to Palette.TEXT
            Style.ON -> Palette.ON to Color.WHITE
            Style.ACTIVE -> Palette.BRAND to Color.WHITE
            Style.OFF_WARN -> Palette.SURFACE_2 to 0xFFFCA5A5.toInt()
            Style.DANGER -> Palette.DANGER to Color.WHITE
        }
        val shape = GradientDrawable().apply {
            cornerRadius = context.dp(14).toFloat()
            setColor(bg)
            if (style == Style.NEUTRAL || style == Style.OFF_WARN) setStroke(context.dp(1), Palette.BORDER)
        }
        background = RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE), shape, null)
        icon.imageTintList = ColorStateList.valueOf(fg)
    }
}

/**
 * One video tile: renderer (created on first use, released with the tile),
 * initial-letter placeholder, name strip, pin / hand / alert chips and a
 * speaking ring.
 */
@SuppressLint("ViewConstructor")
class VideoTile(context: Context) : FrameLayout(context) {
    private var renderer: TextureViewRenderer? = null
    private var rendererRoom: Room? = null
    private var track: VideoTrack? = null
    private val placeholder = TextView(context)
    private val nameView = TextView(context)
    private val chips = TextView(context)
    private val pinView = ImageView(context)
    private val ring = View(context)
    var identity: String? = null
        private set

    init {
        background = GradientDrawable().apply {
            cornerRadius = context.dp(12).toFloat()
            setColor(0xFF020617.toInt())
        }
        clipToOutline = true
        outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
        placeholder.apply {
            layoutParams = LayoutParams(context.dp(48), context.dp(48), Gravity.CENTER)
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            textSize = 20f
            setTypeface(typeface, Typeface.BOLD)
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Palette.SURFACE_2)
            }
        }
        addView(placeholder)
        nameView.apply {
            layoutParams = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM)
            setPadding(context.dp(8), context.dp(14), context.dp(8), context.dp(5))
            setTextColor(Color.WHITE)
            textSize = 12f
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0xCC000000.toInt(), 0x00000000))
        }
        addView(nameView)
        chips.apply {
            layoutParams = LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
                topMargin = context.dp(6)
                marginStart = context.dp(6)
            }
            setPadding(context.dp(6), context.dp(2), context.dp(6), context.dp(2))
            setTextColor(Color.BLACK)
            textSize = 10f
            setTypeface(typeface, Typeface.BOLD)
            background = GradientDrawable().apply {
                cornerRadius = context.dp(9).toFloat()
                setColor(Palette.AMBER)
            }
            visibility = View.GONE
        }
        addView(chips)
        pinView.apply {
            layoutParams = LayoutParams(context.dp(24), context.dp(24), Gravity.TOP or Gravity.END).apply {
                topMargin = context.dp(6)
                marginEnd = context.dp(6)
            }
            setPadding(context.dp(4), context.dp(4), context.dp(4), context.dp(4))
            setImageResource(R.drawable.ic_push_pin)
            imageTintList = ColorStateList.valueOf(Color.BLACK)
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Palette.AMBER)
            }
            contentDescription = "Pinned"
            visibility = View.GONE
        }
        addView(pinView)
        ring.apply {
            layoutParams = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            background = GradientDrawable().apply {
                cornerRadius = context.dp(12).toFloat()
                setStroke(context.dp(3), 0xFF60A5FA.toInt())
                setColor(Color.TRANSPARENT)
            }
            visibility = View.GONE
        }
        addView(ring)
    }

    /**
     * Show [videoTrack] (null = placeholder). [chip] e.g. "✋" / "Not fullscreen".
     */
    fun bind(
        room: Room?,
        id: String?,
        name: String,
        videoTrack: VideoTrack?,
        mirror: Boolean = false,
        pinned: Boolean = false,
        speaking: Boolean = false,
        chip: String? = null,
        emptyText: String? = null,
    ) {
        identity = id
        nameView.text = name
        nameView.visibility = if (name.isBlank()) View.GONE else View.VISIBLE
        placeholder.text = emptyText ?: name.trim().firstOrNull()?.uppercase() ?: ""
        placeholder.textSize = if (emptyText != null) 11f else 20f
        placeholder.layoutParams = (placeholder.layoutParams as LayoutParams).apply {
            width = if (emptyText != null) ViewGroup.LayoutParams.WRAP_CONTENT else context.dp(48)
        }
        placeholder.background = if (emptyText != null) null else GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Palette.SURFACE_2)
        }
        placeholder.setTextColor(if (emptyText != null) Palette.MUTED else Color.WHITE)
        pinView.visibility = if (pinned) View.VISIBLE else View.GONE
        ring.visibility = if (speaking) View.VISIBLE else View.GONE
        chips.visibility = if (chip.isNullOrBlank()) View.GONE else View.VISIBLE
        chips.text = chip
        val desc = buildString {
            append(name.ifBlank { "Empty tile" })
            if (pinned) append(", pinned")
            if (speaking) append(", speaking")
            if (!chip.isNullOrBlank()) append(", ").append(chip)
        }
        contentDescription = desc
        setTrack(room, videoTrack, mirror)
    }

    private fun setTrack(room: Room?, next: VideoTrack?, mirror: Boolean) {
        val r = ensureRenderer(room)
        if (track !== next) {
            try {
                if (r != null) track?.removeRenderer(r)
            } catch (_: Exception) {
            }
            track = next
            try {
                if (r != null) next?.addRenderer(r)
            } catch (e: Exception) {
                android.util.Log.w("VideoTile", "addRenderer", e)
            }
        }
        r?.setMirror(mirror)
        r?.visibility = if (next != null) View.VISIBLE else View.INVISIBLE
        placeholder.visibility = if (next != null) View.GONE else View.VISIBLE
    }

    private fun ensureRenderer(room: Room?): TextureViewRenderer? {
        if (room == null) return renderer
        if (renderer != null && rendererRoom === room) return renderer
        releaseRenderer()
        return try {
            TextureViewRenderer(context).also {
                room.initVideoRenderer(it)
                it.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
                addView(it, 0, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                renderer = it
                rendererRoom = room
            }
        } catch (e: Exception) {
            android.util.Log.w("VideoTile", "renderer", e)
            null
        }
    }

    fun releaseRenderer() {
        val r = renderer ?: return
        try {
            track?.removeRenderer(r)
        } catch (_: Exception) {
        }
        track = null
        try {
            r.release()
        } catch (_: Exception) {
        }
        removeView(r)
        renderer = null
        rendererRoom = null
    }
}

/**
 * Lays its children out as the largest equal tiles (aspect [aspect], w/h) that
 * fit: a 2x2 block in portrait, a row of four on wide short screens, etc.
 */
class TileGrid(context: Context) : ViewGroup(context) {
    var aspect = 4f / 3f
    private val gap = context.dp(8)
    private var cols = 2
    private var tileW = 0
    private var tileH = 0

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = MeasureSpec.getSize(heightMeasureSpec)
        val n = childCount.coerceAtLeast(1)
        var best = 0f
        for (c in 1..n) {
            val rows = ceil(n / c.toFloat()).toInt()
            val maxW = (w - gap * (c - 1)) / c.toFloat()
            val maxH = (h - gap * (rows - 1)) / rows.toFloat()
            val tw = min(maxW, maxH * aspect)
            if (tw > best) {
                best = tw
                cols = c
            }
        }
        tileW = best.toInt().coerceAtLeast(0)
        tileH = (best / aspect).toInt().coerceAtLeast(0)
        val cw = MeasureSpec.makeMeasureSpec(tileW, MeasureSpec.EXACTLY)
        val ch = MeasureSpec.makeMeasureSpec(tileH, MeasureSpec.EXACTLY)
        for (i in 0 until childCount) getChildAt(i).measure(cw, ch)
        setMeasuredDimension(w, h)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val n = childCount
        if (n == 0) return
        val rows = ceil(n / cols.toFloat()).toInt()
        val gridW = cols * tileW + gap * (cols - 1)
        val gridH = rows * tileH + gap * (rows - 1)
        val x0 = ((r - l) - gridW) / 2
        val y0 = ((b - t) - gridH) / 2
        for (i in 0 until n) {
            val row = i / cols
            val col = i % cols
            // Centre a short last row.
            val inRow = if (row == rows - 1) n - row * cols else cols
            val rowOffset = (cols - inRow) * (tileW + gap) / 2
            val x = x0 + rowOffset + col * (tileW + gap)
            val y = y0 + row * (tileH + gap)
            getChildAt(i).layout(x, y, x + tileW, y + tileH)
        }
    }
}
