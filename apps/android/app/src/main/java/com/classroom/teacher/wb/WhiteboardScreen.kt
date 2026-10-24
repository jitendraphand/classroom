package com.classroom.teacher.wb

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.widget.TooltipCompat
import com.classroom.teacher.Palette
import com.classroom.teacher.R
import com.classroom.teacher.RailButton
import com.google.android.material.button.MaterialButton

/**
 * Full-screen whiteboard (Windows WhiteboardHost layout): board in the middle,
 * tools on the left (bottom strip on narrow portrait screens), page bar on
 * top and a slim meeting bar on the right (mic, chat, students, close). No
 * floating video panel is shown while the board is open.
 */
class WhiteboardScreen(context: Context, private val listener: Listener) : FrameLayout(context) {
    interface Listener {
        fun onCloseBoard()
        fun onBoardMic()
        fun onBoardChat()
        fun onBoardRoster()
        fun onBoardText(x: Int, y: Int)
        fun onBoardChanged()
    }

    var host: WbHost? = null
    val board = WhiteboardView(context, { host }) { x, y -> listener.onBoardText(x, y) }
    private val density = resources.displayMetrics.density
    private fun dp(v: Int) = (v * density).toInt()

    private val body = LinearLayout(context)
    private val toolsScrollV = ScrollView(context)
    private val toolsScrollH = HorizontalScrollView(context)
    private val tools = LinearLayout(context)
    private val pageBar = LinearLayout(context)
    private val pageLabel = TextView(context)
    private val meeting = LinearLayout(context)
    private val toolButtons = HashMap<WhiteboardView.Tool, MaterialButton>()
    private val colorButtons = ArrayList<Pair<String, View>>()
    private lateinit var undoBtn: MaterialButton
    private lateinit var redoBtn: MaterialButton
    val micButton = RailButton(context)
    val chatButton = RailButton(context)
    val rosterButton = RailButton(context)
    private var compact = false

    init {
        setBackgroundColor(0xFF0B0F14.toInt())
        board.onLocalChange = { renderPage(); listener.onBoardChanged() }
        val column = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        // Page bar.
        pageBar.apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8), dp(4), dp(8), dp(4))
        }
        pageBar.addView(TextView(context).apply {
            text = "Whiteboard"
            setTextColor(Palette.TEXT)
            textSize = 15f
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        pageBar.addView(chip("‹", "Previous page") { go(-1) })
        pageLabel.setTextColor(Palette.MUTED)
        pageLabel.setPadding(dp(6), 0, dp(6), 0)
        pageBar.addView(pageLabel)
        pageBar.addView(chip("›", "Next page") { go(1) })
        pageBar.addView(chip("+ Page", "Add a page") { addPage() })
        pageBar.addView(chip("Background", "Change the page background") { cycleBg() })
        column.addView(HorizontalScrollView(context).apply { addView(pageBar); isHorizontalScrollBarEnabled = false })

        body.orientation = LinearLayout.HORIZONTAL
        tools.setPadding(dp(4), dp(4), dp(4), dp(4))
        buildTools()
        body.addView(board, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        column.addView(body, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        column.addView(toolsScrollH.apply { isHorizontalScrollBarEnabled = false; visibility = View.GONE })

        val outer = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        outer.addView(column, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        meeting.apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(4), dp(8), dp(4), dp(8))
            setBackgroundColor(Palette.BG)
        }
        micButton.apply { setIcon(R.drawable.ic_mic_off); label = "Turn your mic on"; setOnClickListener { listener.onBoardMic() } }
        chatButton.apply { setIcon(R.drawable.ic_chat); label = "Chat"; setOnClickListener { listener.onBoardChat() } }
        rosterButton.apply { setIcon(R.drawable.ic_group); label = "Students"; setOnClickListener { listener.onBoardRoster() } }
        val close = RailButton(context).apply {
            setIcon(R.drawable.ic_close); label = "Close the whiteboard"; setStyle(RailButton.Style.DANGER)
            setOnClickListener { listener.onCloseBoard() }
        }
        for (b in listOf(micButton, chatButton, rosterButton)) meeting.addView(b, LinearLayout.LayoutParams(dp(48), dp(48)).apply { bottomMargin = dp(6) })
        meeting.addView(View(context), LinearLayout.LayoutParams(1, 0, 1f))
        meeting.addView(close, LinearLayout.LayoutParams(dp(48), dp(48)))
        val meetingScroll = ScrollView(context).apply { isFillViewport = true; addView(meeting) }
        outer.addView(meetingScroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT))
        addView(outer)
        setCompact(false)
    }

    /** Narrow portrait (compact width): tools move into a bottom strip. */
    fun setCompact(on: Boolean) {
        if (compact == on && tools.parent != null) return
        compact = on
        (tools.parent as? ViewGroup)?.removeView(tools)
        (toolsScrollV.parent as? ViewGroup)?.removeView(toolsScrollV)
        if (on) {
            tools.orientation = LinearLayout.HORIZONTAL
            toolsScrollH.addView(tools)
            toolsScrollH.visibility = View.VISIBLE
        } else {
            tools.orientation = LinearLayout.VERTICAL
            toolsScrollV.addView(tools)
            body.addView(toolsScrollV, 0, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT))
            toolsScrollH.visibility = View.GONE
        }
    }

    private fun buildTools() {
        val names = listOf(
            WhiteboardView.Tool.PEN to "Pen", WhiteboardView.Tool.HIGHLIGHT to "Marker", WhiteboardView.Tool.ERASER to "Eraser",
            WhiteboardView.Tool.LINE to "Line", WhiteboardView.Tool.ARROW to "Arrow", WhiteboardView.Tool.RECT to "Box",
            WhiteboardView.Tool.ELLIPSE to "Oval", WhiteboardView.Tool.TEXT to "Text",
        )
        for ((t, n) in names) {
            val b = chip(n, n) { board.tool = t; renderTools() }
            toolButtons[t] = b
            tools.addView(b)
        }
        for (c in Wb.PALETTE) {
            val v = View(context).apply {
                contentDescription = "Colour $c"
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(Color.parseColor(c))
                }
                setOnClickListener { board.color = c; if (board.tool == WhiteboardView.Tool.ERASER) board.tool = WhiteboardView.Tool.PEN; renderTools() }
            }
            colorButtons.add(c to v)
            tools.addView(v, LinearLayout.LayoutParams(dp(30), dp(30)).apply { setMargins(dp(5), dp(4), dp(5), dp(4)) })
        }
        for ((w, n) in listOf(2 to "Thin", 4 to "Medium", 8 to "Thick")) {
            tools.addView(chip(n, "$n line") { board.penWidth = w; renderTools() }.also { it.tag = w })
        }
        undoBtn = chip("Undo", "Undo") { host?.undo(); changed(); listener.onBoardChanged() }
        redoBtn = chip("Redo", "Redo") { host?.redo(); changed(); listener.onBoardChanged() }
        tools.addView(undoBtn)
        tools.addView(redoBtn)
        tools.addView(chip("Clear page", "Clear this page") {
            val h = host ?: return@chip
            h.local(listOf(WbOps.clear(h.doc.currentPage().id)))
            changed(); listener.onBoardChanged()
        })
        renderTools()
    }

    private fun renderTools() {
        for ((t, b) in toolButtons) b.backgroundTintList = ColorStateList.valueOf(if (t == board.tool) Palette.BRAND else Palette.SURFACE_2)
        for ((c, v) in colorButtons) {
            (v.background as GradientDrawable).setStroke(dp(if (c == board.color) 3 else 1), if (c == board.color) Palette.BRAND else Palette.BORDER)
        }
        for (i in 0 until tools.childCount) {
            val v = tools.getChildAt(i)
            if (v is MaterialButton && v.tag is Int) v.backgroundTintList = ColorStateList.valueOf(if (v.tag == board.penWidth) Palette.BRAND else Palette.SURFACE_2)
        }
    }

    private fun go(d: Int) {
        val h = host ?: return
        val n = (h.doc.cur + d).coerceIn(0, h.doc.pages.size - 1)
        if (n != h.doc.cur) { h.local(listOf(WbOps.go(n)), record = false); changed(); listener.onBoardChanged() }
    }

    private fun addPage() {
        val h = host ?: return
        if (h.doc.pages.size >= Wb.MAX_PAGES) return
        val at = h.doc.cur + 1
        h.local(listOf(WbOps.newPage(at, Wb.newId("p"), h.doc.currentPage().bg), WbOps.go(at)))
        changed(); listener.onBoardChanged()
    }

    private fun cycleBg() {
        val h = host ?: return
        val p = h.doc.currentPage()
        val next = Wb.BACKGROUNDS[(Wb.BACKGROUNDS.indexOf(p.bg) + 1) % Wb.BACKGROUNDS.size]
        h.local(listOf(WbOps.bg(p.id, next)))
        // Keep ink visible on black / white.
        if (board.color == Wb.inkFor(p.bg)) board.color = Wb.inkFor(next)
        changed(); listener.onBoardChanged()
    }

    /** After any change (local or remote). */
    fun changed() {
        renderPage()
        board.changed()
    }

    private fun renderPage() {
        val h = host ?: return
        pageLabel.text = "${h.doc.cur + 1} / ${h.doc.pages.size}"
        undoBtn.isEnabled = h.canUndo
        redoBtn.isEnabled = h.canRedo
        undoBtn.alpha = if (h.canUndo) 1f else 0.5f
        redoBtn.alpha = if (h.canRedo) 1f else 0.5f
    }

    private fun chip(text: String, label: String, onClick: () -> Unit) = MaterialButton(context).apply {
        this.text = text
        isAllCaps = false
        textSize = 13f
        setTextColor(Palette.TEXT)
        backgroundTintList = ColorStateList.valueOf(Palette.SURFACE_2)
        minHeight = dp(40); minimumHeight = dp(40)
        minWidth = dp(48); minimumWidth = dp(48)
        insetTop = 0; insetBottom = 0
        contentDescription = label
        TooltipCompat.setTooltipText(this, label)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { setMargins(dp(3), dp(2), dp(3), dp(2)) }
        setOnClickListener { onClick() }
    }
}
