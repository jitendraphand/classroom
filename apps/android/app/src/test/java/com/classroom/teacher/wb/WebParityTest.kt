package com.classroom.teacher.wb

import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Drift check: the Kotlin whiteboard must keep the web app's constants
 * (page size, limits, batching, backgrounds, palette, laser and snapping
 * timings, pen widths). The android branch carries apps/web merged from
 * main, so the web sources sit next to this module; outside that layout the
 * test is skipped.
 */
class WebParityTest {
    private fun webFile(rel: String): File? {
        var dir: File? = File("").absoluteFile
        repeat(5) {
            val f = File(dir, "apps/web/src/lib/whiteboard/$rel")
            if (f.exists()) return f
            dir = dir?.parentFile
        }
        return null
    }

    private fun read(rel: String): String {
        val f = webFile(rel)
        assumeTrue("web sources not found next to the Android app", f != null)
        return f!!.readText()
    }

    private fun constNum(src: String, name: String): Long {
        val m = Regex("""export const $name = ([0-9_]+);""").find(src) ?: error("$name not found in web source")
        return m.groupValues[1].replace("_", "").toLong()
    }

    private fun stringList(src: String, decl: String): List<String> {
        val m = Regex("""$decl[^=]*= \[([^\]]*)]""").find(src) ?: error("$decl not found in web source")
        return Regex("""'([^']*)'""").findAll(m.groupValues[1]).map { it.groupValues[1] }.toList()
    }

    @Test
    fun modelConstantsMatchTheWeb() {
        val model = read("model.ts")
        assertEquals(constNum(model, "PAGE_W"), Wb.PAGE_W.toLong())
        assertEquals(constNum(model, "PAGE_H"), Wb.PAGE_H.toLong())
        assertEquals(constNum(model, "MAX_PAGES"), Wb.MAX_PAGES.toLong())
        assertEquals(constNum(model, "MAX_ITEMS_PER_PAGE"), Wb.MAX_ITEMS_PER_PAGE.toLong())
        assertEquals(constNum(model, "MAX_POINTS_PER_STROKE"), Wb.MAX_POINTS_PER_STROKE.toLong())
        assertEquals(constNum(model, "BATCH_MS"), Wb.BATCH_MS)
        assertEquals(constNum(model, "CHUNK_CHARS"), Wb.CHUNK_CHARS.toLong())
        assertEquals(constNum(model, "LASER_MS"), Wb.LASER_MS)
        assertEquals(stringList(model, "export const BACKGROUNDS"), Wb.BACKGROUNDS)
        assertEquals(stringList(model, "export const SHAPE_KINDS"), Wb.SHAPE_KINDS)
        assertEquals(stringList(model, "export const PALETTE"), Wb.PALETTE)
    }

    @Test
    fun androidIconsAreGeneratedFromTheCurrentWebIcons() {
        val icons = read("icons.tsx")
        val block = icons.substring(icons.indexOf("export const WB_ICONS = {"), icons.indexOf("} satisfies") + 1)
        val sha = java.security.MessageDigest.getInstance("SHA-256").digest(block.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        var dir: File? = File("").absoluteFile
        var stamp: File? = null
        repeat(5) {
            val f = File(dir, "apps/android/scripts/wb-icons.sha256").takeIf { it.exists() } ?: File(dir, "scripts/wb-icons.sha256").takeIf { it.exists() }
            if (stamp == null && f != null) stamp = f
            dir = dir?.parentFile
        }
        assumeTrue("icon stamp not found", stamp != null)
        assertEquals("Web icons changed: run node apps/android/scripts/wb-icons-android.mjs", sha, stamp!!.readText().trim())
    }

    @Test
    fun snapAndEditorConstantsMatchTheWeb() {
        val rec = read("recognize.ts")
        assertEquals(constNum(rec, "SNAP_HOLD_MS"), WbRecognize.SNAP_HOLD_MS)
        assertEquals(constNum(rec, "SNAP_STILL_PX"), WbRecognize.SNAP_STILL_PX.toLong())
        val board = read("WhiteboardBoard.tsx")
        val widths = Regex("""export const WIDTHS = \[([^\]]*)]""").find(board)!!.groupValues[1].split(",").map { it.trim().toInt() }
        assertEquals(widths, WbStyle.WIDTHS)
        val render = read("render.ts")
        // Pressure width rule: w * (0.35 + 0.9 * pr / 100).
        assertEquals(true, render.contains("return w * (0.35 + (0.9 * pr) / 100);"))
        assertEquals(WbStyle.widthAt(10f, 0), 3.5f, 0.001f)
        assertEquals(WbStyle.widthAt(10f, 100), 12.5f, 0.001f)
    }
}
