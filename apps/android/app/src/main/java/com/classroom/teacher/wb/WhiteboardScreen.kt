package com.classroom.teacher.wb

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.widget.TooltipCompat
import com.classroom.teacher.Palette
import com.classroom.teacher.R
import com.classroom.teacher.RailButton

/**
 * Full-screen whiteboard, laid out like the web / Windows teacher board: the
 * board in the middle, the grouped tool column on the left (same groups,
 * order and icons as the web FlyoutBar: select, draw, laser, shapes, erase,
 * colour & size, undo, redo, pages, view), each group's options opening in a
 * panel beside it, and the slim meeting bar on the right (mic, chat,
 * students, close). A floating bar above a selection offers Duplicate and
 * Delete.
 */
class WhiteboardScreen(context: Context, private val listener: Listener) : FrameLayout(context) {
    interface Listener {
        fun onCloseBoard()
        fun onBoardMic()
        fun onBoardChat()
        fun onBoardRoster()
        fun onBoardText(x: Int, y: Int)
        fun onBoardChanged()
        fun onBoardInsertImage()
        fun onBoardExport(pdf: Boolean)
    }

    var host: WbHost? = null
    val board = WhiteboardView(context, { host }) { x, y -> listener.onBoardText(x, y) }
    private val density = resources.displayMetrics.density
    private fun dp(v: Int) = (v * density).toInt()

    private val column = LinearLayout(context)
    private val boardBox = FrameLayout(context)
    private val flyout = LinearLayout(context)
    private val selBar = LinearLayout(context)
    private val meeting = LinearLayout(context)
    private val groupButtons = LinkedHashMap<String, ImageView>()
    private var pageLabel: TextView? = null
    private var openGroup: String? = null
    val micButton = RailButton(context)
    val chatButton = RailButton(context)
    val rosterButton = RailButton(context)

    init {
        setBackgroundColor(0xFF0B0F14.toInt())
        board.onLocalChange = { renderTools(); listener.onBoardChanged() }
        board.onSelection = { renderTools() }
        board.onZoom = { if (openGroup == "view") openFlyout("view") }
        board.onSelectionFrame = { r -> placeSelectionBar(r) }

        val outer = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        // Tool column (scrolls on short screens, like the web bar).
        column.orientation = LinearLayout.VERTICAL
        column.gravity = Gravity.CENTER_HORIZONTAL
        column.setPadding(dp(6), dp(6), dp(6), dp(6))
        val columnScroll = ScrollView(context).apply {
            isVerticalScrollBarEnabled = false
            setBackgroundColor(BAR_BG)
            addView(column)
            setOnScrollChangeListener { _, _, _, _, _ -> closeFlyout() }
        }
        buildGroups()
        outer.addView(columnScroll, LinearLayout.LayoutParams(dp(BAR_DP), ViewGroup.LayoutParams.MATCH_PARENT))

        // Board with its overlays (options panel, selection bar).
        boardBox.addView(board, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        flyout.apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), dp(8), dp(8), dp(8))
            background = panelBg()
            elevation = dp(8).toFloat()
            visibility = View.GONE
            isClickable = true
        }
        boardBox.addView(flyout, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        selBar.apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(4), dp(4), dp(4), dp(4))
            background = panelBg()
            elevation = dp(6).toFloat()
            // INVISIBLE, not GONE: showing / hiding it while drawing never re-lays out the board.
            visibility = View.INVISIBLE
            addView(iconButton("duplicate", "Duplicate selection") { board.duplicateSelection() }, LinearLayout.LayoutParams(dp(40), dp(40)))
            addView(iconButton("clear", "Delete selection", danger = true) { board.deleteSelection() }, LinearLayout.LayoutParams(dp(40), dp(40)).apply { marginStart = dp(4) })
        }
        boardBox.addView(selBar, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        outer.addView(boardBox, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))

        // Meeting bar on the right (web meeting bar / Windows whiteboard window).
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
        renderTools()
    }

    /** Kept for the class screen; the board uses the same left column at every width (as on the web). */
    @Suppress("UNUSED_PARAMETER")
    fun setCompact(on: Boolean) = Unit

    // ---- groups (web editGroups order) ----
    private fun buildGroups() {
        addGroup("select", "Select, move and resize") { pick(WhiteboardView.Tool.SELECT) }
        addGroup("draw", "Draw: pen, highlighter, text") { toggleFlyout("draw") }
        addGroup("laser", "Laser pointer") { pick(WhiteboardView.Tool.LASER) }
        addGroup("shapes", "Shapes: line, arrow, rectangle, ellipse, triangle") { toggleFlyout("shapes") }
        addGroup("erase", "Erase") { toggleFlyout("erase") }
        addGroup("color", "Colour and size") { toggleFlyout("color") }
        addGroup("undo", "Undo") { host?.undo(); afterHostChange() }
        addGroup("redo", "Redo") { host?.redo(); afterHostChange() }
        // Pages: a page counter instead of an icon (web shows "1/3").
        val pages = TextView(context).apply {
            setTextColor(Palette.TEXT)
            textSize = 11f
            gravity = Gravity.CENTER
            background = btnBg(false)
            contentDescription = "Pages and background"
            TooltipCompat.setTooltipText(this, "Pages and background")
            setOnClickListener { toggleFlyout("pages") }
        }
        pageLabel = pages
        column.addView(pages, LinearLayout.LayoutParams(dp(BTN_DP), dp(BTN_DP)).apply { bottomMargin = dp(6) })
        addGroup("view", "Zoom, pan, image and export") { toggleFlyout("view") }
    }

    private fun addGroup(id: String, label: String, onClick: () -> Unit) {
        val b = ImageView(context).apply {
            scaleType = ImageView.ScaleType.CENTER
            contentDescription = label
            TooltipCompat.setTooltipText(this, label)
            setOnClickListener { onClick() }
        }
        groupButtons[id] = b
        column.addView(b, LinearLayout.LayoutParams(dp(BTN_DP), dp(BTN_DP)).apply { bottomMargin = dp(6) })
    }

    private fun pick(t: WhiteboardView.Tool) {
        board.tool = t
        closeFlyout()
        renderTools()
    }

    private fun afterHostChange() {
        board.changed()
        renderTools()
        listener.onBoardChanged()
    }

    private fun toggleFlyout(id: String) {
        if (openGroup == id) closeFlyout() else openFlyout(id)
    }

    private fun closeFlyout() {
        openGroup = null
        flyout.visibility = View.GONE
        renderTools()
    }

    private fun openFlyout(id: String) {
        openGroup = id
        flyout.removeAllViews()
        when (id) {
            "draw" -> flyRow(tool(WhiteboardView.Tool.PEN), tool(WhiteboardView.Tool.HIGHLIGHT), tool(WhiteboardView.Tool.TEXT))
            "shapes" -> {
                flyRow(tool(WhiteboardView.Tool.LINE), tool(WhiteboardView.Tool.ARROW), tool(WhiteboardView.Tool.RECT))
                flyRow(
                    tool(WhiteboardView.Tool.ELLIPSE), tool(WhiteboardView.Tool.TRI),
                    iconButton("fill", "Fill rectangles, ellipses and triangles", active = board.fillShapes) { board.fillShapes = !board.fillShapes; openFlyout("shapes") },
                )
            }
            "erase" -> flyRow(
                tool(WhiteboardView.Tool.ERASER), tool(WhiteboardView.Tool.AREA),
                iconButton("clear", "Clear page") {
                    val h = host ?: return@iconButton
                    h.local(listOf(WbOps.clear(h.doc.currentPage().id)))
                    closeFlyout(); afterHostChange()
                },
            )
            "color" -> {
                val grid = GridLayout(context).apply { columnCount = 4 }
                for (c in Wb.PALETTE) {
                    val v = View(context).apply {
                        contentDescription = "Colour $c"
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.OVAL
                            setColor(Color.parseColor(c))
                            setStroke(dp(if (c == board.color) 3 else 1), if (c == board.color) 0xFF60A5FA.toInt() else 0xFF475569.toInt())
                        }
                        setOnClickListener { board.color = c; if (board.tool == WhiteboardView.Tool.ERASER) board.tool = WhiteboardView.Tool.PEN; closeFlyout() }
                    }
                    grid.addView(v, GridLayout.LayoutParams().apply { width = dp(28); height = dp(28); setMargins(dp(3), dp(3), dp(3), dp(3)) })
                }
                flyout.addView(grid)
                val widths = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
                for (w in WbStyle.WIDTHS) {
                    val dot = View(context).apply {
                        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.parseColor(board.color)) }
                    }
                    val holder = FrameLayout(context).apply {
                        background = btnBg(board.penWidth == w)
                        contentDescription = "Thickness $w px"
                        setOnClickListener { board.penWidth = w; closeFlyout() }
                        val s = dp(minOf(20, w + 2))
                        addView(dot, LayoutParams(s, s, Gravity.CENTER))
                    }
                    widths.addView(holder, LinearLayout.LayoutParams(dp(38), dp(38)).apply { marginEnd = dp(4) })
                }
                flyout.addView(widths, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
            }
            "pages" -> {
                val h = host
                flyRow(
                    iconButton("prev", "Previous page") { go(-1) },
                    iconButton("next", "Next page") { go(1) },
                    iconButton("add_page", "New page") { addPage() },
                )
                val grid = GridLayout(context).apply { columnCount = 3 }
                for (bg in Wb.BACKGROUNDS) {
                    val label = WbStyle.BG_LABEL[bg] ?: bg
                    val t = TextView(context).apply {
                        text = label
                        setTextColor(Palette.TEXT)
                        textSize = 12f
                        gravity = Gravity.CENTER
                        background = btnBg(h?.doc?.currentPage()?.bg == bg)
                        setPadding(dp(8), 0, dp(8), 0)
                        contentDescription = "Background: $label"
                        setOnClickListener { setBg(bg) }
                    }
                    grid.addView(t, GridLayout.LayoutParams().apply { width = dp(58); height = dp(38); setMargins(dp(2), dp(2), dp(2), dp(2)) })
                }
                flyout.addView(grid, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) })
            }
            "view" -> {
                val pct = TextView(context).apply {
                    text = "${Math.round(board.zoom * 100)}%"
                    setTextColor(Palette.TEXT)
                    textSize = 12f
                    gravity = Gravity.CENTER
                    background = btnBg(false)
                    contentDescription = "Fit page"
                    setOnClickListener { board.resetZoom() }
                }
                flyRow(tool(WhiteboardView.Tool.HAND), iconButton("zoom_out", "Zoom out") { board.zoomBy(1 / 1.25f) }, pct, iconButton("zoom_in", "Zoom in") { board.zoomBy(1.25f) })
                flyRow(
                    iconButton("image", "Insert image") { closeFlyout(); listener.onBoardInsertImage() },
                    textButton("PNG", "Export this page as PNG") { closeFlyout(); listener.onBoardExport(pdf = false) },
                    textButton("PDF", "Export all pages as PDF") { closeFlyout(); listener.onBoardExport(pdf = true) },
                )
            }
        }
        flyout.visibility = View.VISIBLE
        // Line the panel up with its group button.
        val anchor = if (id == "pages") pageLabel else groupButtons[id]
        flyout.post {
            val top = (anchor?.top ?: 0) - ((anchor?.parent?.parent as? ScrollView)?.scrollY ?: 0) - dp(8)
            flyout.translationX = dp(6).toFloat()
            flyout.translationY = top.coerceIn(dp(4), maxOf(dp(4), boardBox.height - flyout.height - dp(4))).toFloat()
        }
        renderTools()
    }

    private fun flyRow(vararg views: View) {
        val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        for ((i, v) in views.withIndex()) {
            row.addView(v, LinearLayout.LayoutParams(if (v is TextView) dp(52) else dp(40), dp(40)).apply {
                if (i > 0) marginStart = dp(4)
            })
        }
        flyout.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            if (flyout.childCount > 0) topMargin = dp(6)
        })
    }

    private fun tool(t: WhiteboardView.Tool): View {
        val (icon, label) = TOOL_ICON[t] ?: ("pen" to t.name)
        return iconButton(icon, label, active = board.tool == t) { pick(t) }
    }

    private fun iconButton(icon: String, label: String, active: Boolean = false, danger: Boolean = false, onClick: () -> Unit) = ImageView(context).apply {
        setImageResource(iconRes(icon))
        imageTintList = ColorStateList.valueOf(ICON)
        scaleType = ImageView.ScaleType.CENTER
        background = if (danger) btnBg(false, 0xFF7F1D1D.toInt()) else btnBg(active)
        contentDescription = label
        TooltipCompat.setTooltipText(this, label)
        setOnClickListener { onClick() }
    }

    private fun textButton(text: String, label: String, onClick: () -> Unit) = TextView(context).apply {
        this.text = text
        setTextColor(Palette.TEXT)
        textSize = 13f
        gravity = Gravity.CENTER
        background = btnBg(false)
        setPadding(dp(10), 0, dp(10), 0)
        contentDescription = label
        TooltipCompat.setTooltipText(this, label)
        setOnClickListener { onClick() }
    }

    private fun iconRes(name: String): Int = when (name) {
        "select" -> R.drawable.wb_select
        "pen" -> R.drawable.wb_pen
        "highlighter" -> R.drawable.wb_highlighter
        "text" -> R.drawable.wb_text
        "laser" -> R.drawable.wb_laser
        "shapes" -> R.drawable.wb_shapes
        "line" -> R.drawable.wb_line
        "arrow" -> R.drawable.wb_arrow
        "rect" -> R.drawable.wb_rect
        "ellipse" -> R.drawable.wb_ellipse
        "tri" -> R.drawable.wb_tri
        "fill" -> R.drawable.wb_fill
        "eraser" -> R.drawable.wb_eraser
        "area_eraser" -> R.drawable.wb_area_eraser
        "undo" -> R.drawable.wb_undo
        "redo" -> R.drawable.wb_redo
        "clear" -> R.drawable.wb_clear
        "duplicate" -> R.drawable.wb_duplicate
        "prev" -> R.drawable.wb_prev
        "next" -> R.drawable.wb_next
        "add_page" -> R.drawable.wb_add_page
        "hand" -> R.drawable.wb_hand
        "zoom_in" -> R.drawable.wb_zoom_in
        "zoom_out" -> R.drawable.wb_zoom_out
        "view" -> R.drawable.wb_view
        "image" -> R.drawable.wb_image
        else -> R.drawable.wb_pen
    }

    private fun btnBg(active: Boolean, color: Int? = null) = GradientDrawable().apply {
        cornerRadius = dp(10).toFloat()
        setColor(color ?: if (active) ACTIVE else Color.argb(15, 255, 255, 255))
        setStroke(dp(1), Color.argb(31, 255, 255, 255))
    }

    private fun panelBg() = GradientDrawable().apply {
        cornerRadius = dp(12).toFloat()
        setColor(BAR_BG)
        setStroke(dp(1), Color.argb(36, 255, 255, 255))
    }

    /** Group icons and highlights follow the current tool (web editGroups). */
    private fun renderTools() {
        val t = board.tool
        val h = host
        fun set(id: String, icon: String, active: Boolean, enabled: Boolean = true) {
            val b = groupButtons[id] ?: return
            b.setImageResource(iconRes(icon))
            b.imageTintList = ColorStateList.valueOf(ICON)
            b.background = btnBg(active || openGroup == id)
            b.alpha = if (enabled) 1f else 0.45f
            b.isEnabled = enabled
        }
        set("select", "select", t == WhiteboardView.Tool.SELECT)
        set("draw", when (t) { WhiteboardView.Tool.HIGHLIGHT -> "highlighter"; WhiteboardView.Tool.TEXT -> "text"; else -> "pen" },
            t == WhiteboardView.Tool.PEN || t == WhiteboardView.Tool.HIGHLIGHT || t == WhiteboardView.Tool.TEXT)
        set("laser", "laser", t == WhiteboardView.Tool.LASER)
        val shapeIcon = when (t) {
            WhiteboardView.Tool.LINE -> "line"; WhiteboardView.Tool.ARROW -> "arrow"; WhiteboardView.Tool.RECT -> "rect"
            WhiteboardView.Tool.ELLIPSE -> "ellipse"; WhiteboardView.Tool.TRI -> "tri"; else -> null
        }
        set("shapes", shapeIcon ?: "shapes", shapeIcon != null)
        set("erase", if (t == WhiteboardView.Tool.AREA) "area_eraser" else "eraser", t == WhiteboardView.Tool.ERASER || t == WhiteboardView.Tool.AREA)
        set("undo", "undo", false, h?.canUndo == true)
        set("redo", "redo", false, h?.canRedo == true)
        set("view", "view", t == WhiteboardView.Tool.HAND)
        // Colour group: a swatch of the current colour.
        groupButtons["color"]?.apply {
            setImageDrawable(GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor(board.color))
                setStroke(dp(2), 0xFFE2E8F0.toInt())
                setSize(dp(18), dp(18))
            })
            imageTintList = null
            background = btnBg(openGroup == "color")
        }
        pageLabel?.apply {
            text = if (h != null) "${h.doc.cur + 1}/${h.doc.pages.size}" else "1/1"
            background = btnBg(openGroup == "pages")
        }
        if (!board.hasSelection) selBar.visibility = View.INVISIBLE
    }

    private fun placeSelectionBar(r: RectF?) {
        if (r == null || board.tool != WhiteboardView.Tool.SELECT) {
            if (selBar.visibility != View.INVISIBLE) selBar.visibility = View.INVISIBLE
            return
        }
        selBar.visibility = View.VISIBLE
        val w = if (selBar.width > 0) selBar.width else dp(92)
        selBar.translationX = r.left.coerceIn(dp(4).toFloat(), maxOf(dp(4).toFloat(), (boardBox.width - w - dp(4)).toFloat()))
        selBar.translationY = maxOf(dp(4).toFloat(), r.top - dp(52))
    }

    override fun onInterceptTouchEvent(e: MotionEvent): Boolean {
        // A touch on the board outside the open panel closes it first (web flyout rule).
        if (e.actionMasked == MotionEvent.ACTION_DOWN && flyout.visibility == View.VISIBLE) {
            val loc = IntArray(2)
            flyout.getLocationOnScreen(loc)
            val inside = e.rawX >= loc[0] && e.rawX <= loc[0] + flyout.width && e.rawY >= loc[1] && e.rawY <= loc[1] + flyout.height
            val colLoc = IntArray(2)
            column.getLocationOnScreen(colLoc)
            val inColumn = e.rawX >= colLoc[0] && e.rawX <= colLoc[0] + column.width
            if (!inside && !inColumn) {
                closeFlyout()
                return true
            }
        }
        return false
    }

    private fun go(d: Int) {
        val h = host ?: return
        val n = (h.doc.cur + d).coerceIn(0, h.doc.pages.size - 1)
        if (n != h.doc.cur) { h.local(listOf(WbOps.go(n))); afterHostChange(); openFlyout("pages") }
    }

    private fun addPage() {
        val h = host ?: return
        if (h.doc.pages.size >= Wb.MAX_PAGES) return
        val at = h.doc.cur + 1
        h.local(listOf(WbOps.newPage(at, Wb.newId("p"), h.doc.currentPage().bg)))
        afterHostChange()
        openFlyout("pages")
    }

    private fun setBg(bg: String) {
        val h = host ?: return
        val p = h.doc.currentPage()
        h.local(listOf(WbOps.bg(p.id, bg)))
        // Keep ink visible on black / white (web setBg).
        if ((bg == "black" && board.color == "#111111") || (bg != "black" && board.color == "#ffffff")) board.color = Wb.inkFor(bg)
        afterHostChange()
        openFlyout("pages")
    }

    /** After any change (local or remote). */
    fun changed() {
        renderTools()
        board.changed()
    }

    companion object {
        private const val BAR_DP = 54
        private const val BTN_DP = 40
        private const val BAR_BG = 0xFF111827.toInt()
        private const val ACTIVE = 0xFF2563EB.toInt()
        private const val ICON = 0xFFE2E8F0.toInt()
        private val TOOL_ICON = mapOf(
            WhiteboardView.Tool.SELECT to ("select" to "Select, move and resize"),
            WhiteboardView.Tool.PEN to ("pen" to "Pen"),
            WhiteboardView.Tool.HIGHLIGHT to ("highlighter" to "Highlighter"),
            WhiteboardView.Tool.LASER to ("laser" to "Laser pointer"),
            WhiteboardView.Tool.ERASER to ("eraser" to "Eraser"),
            WhiteboardView.Tool.AREA to ("area_eraser" to "Area eraser"),
            WhiteboardView.Tool.LINE to ("line" to "Line"),
            WhiteboardView.Tool.ARROW to ("arrow" to "Arrow"),
            WhiteboardView.Tool.RECT to ("rect" to "Rectangle"),
            WhiteboardView.Tool.ELLIPSE to ("ellipse" to "Ellipse"),
            WhiteboardView.Tool.TRI to ("tri" to "Triangle"),
            WhiteboardView.Tool.TEXT to ("text" to "Text"),
            WhiteboardView.Tool.HAND to ("hand" to "Pan"),
        )
    }
}
