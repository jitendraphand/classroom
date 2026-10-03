package com.classroom.teacher

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.widget.TooltipCompat
import com.google.android.material.button.MaterialButton

private fun Context.dpx(v: Int) = (v * resources.displayMetrics.density).toInt()

/**
 * Side panel (landscape / wide) or bottom sheet (portrait) opened from the
 * rail: either the class chat or the roster with the waiting room. One view,
 * re-parented by MainActivity when the orientation changes.
 */
class ClassPanel(context: Context, private val listener: Listener) : LinearLayout(context) {
    enum class Kind { CHAT, ROSTER }

    interface Listener {
        fun onClosePanel()
        fun onSendChat(text: String)
        fun onAdmit(participantId: String)
        fun onAdmitAll()
        fun onMuteStudent(participantId: String, muted: Boolean)
        fun onPinStudent(participantId: String, pinned: Boolean)
        fun onLowerHand(participantId: String)
    }

    var kind: Kind = Kind.ROSTER
        private set

    private val title = TextView(context)
    private val chatBox = LinearLayout(context)
    private val chatScroll = ScrollView(context)
    private val chatLog = TextView(context)
    private val chatInput = EditText(context)
    private val rosterScroll = ScrollView(context)
    private val rosterList = LinearLayout(context)

    init {
        orientation = VERTICAL
        background = GradientDrawable().apply {
            cornerRadius = context.dpx(16).toFloat()
            setColor(0xFF111827.toInt())
            setStroke(context.dpx(1), Palette.BORDER)
        }
        isClickable = true // swallow taps so the scrim behind does not close it
        val header = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(context.dpx(16), context.dpx(8), context.dpx(4), context.dpx(4))
        }
        title.apply {
            setTextColor(Palette.TEXT)
            textSize = 17f
            setTypeface(typeface, Typeface.BOLD)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }
        header.addView(title, LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(iconButton(R.drawable.ic_close, "Close panel") { listener.onClosePanel() })
        addView(header)

        // Chat
        chatBox.orientation = VERTICAL
        chatLog.apply {
            setTextColor(0xFFE2E8F0.toInt())
            textSize = 14f
            setLineSpacing(0f, 1.15f)
            setPadding(context.dpx(16), context.dpx(4), context.dpx(16), context.dpx(8))
            setTextIsSelectable(true)
        }
        chatScroll.addView(chatLog)
        chatBox.addView(chatScroll, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        val inputRow = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(context.dpx(12), context.dpx(4), context.dpx(4), context.dpx(8))
        }
        chatInput.apply {
            hint = "Message everyone"
            setTextColor(Palette.TEXT)
            setHintTextColor(0xFF64748B.toInt())
            textSize = 15f
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            imeOptions = EditorInfo.IME_ACTION_SEND
            maxLines = 3
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            setOnEditorActionListener { _, action, _ ->
                if (action == EditorInfo.IME_ACTION_SEND) {
                    send(); true
                } else {
                    false
                }
            }
        }
        inputRow.addView(chatInput, LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        inputRow.addView(iconButton(R.drawable.ic_send, "Send", tint = 0xFF60A5FA.toInt()) { send() })
        chatBox.addView(inputRow)
        addView(chatBox, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        // Roster
        rosterList.orientation = VERTICAL
        rosterList.setPadding(context.dpx(12), 0, context.dpx(12), context.dpx(12))
        rosterScroll.addView(rosterList)
        addView(rosterScroll, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        show(Kind.ROSTER)
    }

    fun show(k: Kind) {
        kind = k
        title.text = if (k == Kind.CHAT) "Chat" else "Students"
        chatBox.visibility = if (k == Kind.CHAT) View.VISIBLE else View.GONE
        rosterScroll.visibility = if (k == Kind.ROSTER) View.VISIBLE else View.GONE
    }

    private fun send() {
        val text = chatInput.text.toString().trim()
        if (text.isEmpty()) return
        listener.onSendChat(text)
        chatInput.setText("")
    }

    fun renderChat(lines: String) {
        val atBottom = !chatScroll.canScrollVertically(1)
        val next = lines.ifBlank { "No messages yet." }
        if (chatLog.text.toString() == next) return
        chatLog.text = next
        if (atBottom) chatScroll.post { chatScroll.fullScroll(View.FOCUS_DOWN) }
    }

    fun renderRoster(waiting: List<Pair<String, String>>, students: List<StudentInfo>, pinsFull: Boolean) {
        rosterList.removeAllViews()
        if (waiting.isNotEmpty()) {
            val head = LinearLayout(context).apply {
                orientation = HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, context.dpx(8), 0, context.dpx(4))
            }
            head.addView(sectionLabel("Waiting (${waiting.size})", Palette.AMBER), LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            if (waiting.size > 1) head.addView(textButton("Admit all", Palette.AMBER, Color.BLACK) { listener.onAdmitAll() })
            rosterList.addView(head)
            for ((id, name) in waiting) {
                val row = row()
                row.addView(nameBlock(name, "Waiting to join", null), LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                row.addView(textButton("Admit", Palette.AMBER, Color.BLACK) { listener.onAdmit(id) })
                rosterList.addView(row)
            }
        }
        rosterList.addView(sectionLabel(if (students.isEmpty()) "No students in class yet" else "In class (${students.size})", Palette.MUTED).apply {
            setPadding(0, context.dpx(12), 0, context.dpx(4))
        })
        for (s in ClassLogic.sortRoster(students)) {
            val row = row()
            if (s.handRaised) row.setBackgroundColor(0x1FF59E0B)
            val sub = buildList {
                if (s.muted) add("Muted")
                if (s.pinned) add("Pinned")
                if (s.focusAlert) add(if (s.focus == "away") "Switched away" else "Not fullscreen")
            }.joinToString(" · ")
            row.addView(nameBlock(s.name, sub.ifBlank { "Can speak" }, if (s.handRaised) R.drawable.ic_hand else null), LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            if (s.handRaised) {
                row.addView(iconButton(R.drawable.ic_hand, "Lower ${s.name}'s hand", tint = Palette.AMBER) { listener.onLowerHand(s.id) })
            }
            row.addView(
                iconButton(
                    if (s.muted) R.drawable.ic_mic_off else R.drawable.ic_mic,
                    if (s.muted) "Unmute ${s.name}" else "Mute ${s.name}",
                    tint = if (s.muted) 0xFFFCA5A5.toInt() else 0xFF86EFAC.toInt(),
                ) { listener.onMuteStudent(s.id, !s.muted) },
            )
            val pinBtn = iconButton(
                R.drawable.ic_push_pin,
                if (s.pinned) "Unpin ${s.name}'s video" else "Pin ${s.name}'s video",
                tint = if (s.pinned) Palette.AMBER else Palette.MUTED,
            ) { listener.onPinStudent(s.id, !s.pinned) }
            if (!s.pinned && pinsFull) pinBtn.alpha = 0.5f
            row.addView(pinBtn)
            rosterList.addView(row)
        }
    }

    private fun row() = LinearLayout(context).apply {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = context.dpx(56)
        setPadding(context.dpx(4), context.dpx(2), 0, context.dpx(2))
    }

    private fun sectionLabel(text: String, color: Int) = TextView(context).apply {
        this.text = text.uppercase()
        setTextColor(color)
        textSize = 12f
        letterSpacing = 0.06f
        setTypeface(typeface, Typeface.BOLD)
    }

    private fun nameBlock(name: String, sub: String, iconRes: Int?) = LinearLayout(context).apply {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        if (iconRes != null) {
            addView(ImageView(context).apply {
                setImageResource(iconRes)
                imageTintList = ColorStateList.valueOf(Palette.AMBER)
                contentDescription = "Hand raised"
            }, LayoutParams(context.dpx(18), context.dpx(18)).apply { marginEnd = context.dpx(8) })
        }
        val texts = LinearLayout(context).apply { orientation = VERTICAL }
        texts.addView(TextView(context).apply {
            text = name
            setTextColor(Palette.TEXT)
            textSize = 15f
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        })
        texts.addView(TextView(context).apply {
            text = sub
            setTextColor(Palette.MUTED)
            textSize = 12f
            maxLines = 1
        })
        addView(texts)
    }

    private fun iconButton(res: Int, label: String, tint: Int = Palette.TEXT, onClick: () -> Unit) = ImageButton(context).apply {
        setImageResource(res)
        imageTintList = ColorStateList.valueOf(tint)
        contentDescription = label
        TooltipCompat.setTooltipText(this, label)
        background = RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE), null, GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.WHITE)
        })
        layoutParams = LayoutParams(context.dpx(48), context.dpx(48))
        setOnClickListener { onClick() }
    }

    private fun textButton(text: String, bg: Int, fg: Int, onClick: () -> Unit) = MaterialButton(context).apply {
        this.text = text
        isAllCaps = false
        textSize = 13f
        backgroundTintList = ColorStateList.valueOf(bg)
        setTextColor(fg)
        minHeight = context.dpx(40)
        minimumHeight = context.dpx(40)
        insetTop = 0
        insetBottom = 0
        setOnClickListener { onClick() }
    }
}
