package com.classroom.teacher.wb

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfDocument
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File

/** Whiteboard pictures in and pages out (web: Insert image, Export PNG / PDF). */
object WbFiles {
    /** A picture from the gallery / files, decoded at most ~2560 px on its long side. */
    fun decodeImage(cr: ContentResolver, uri: Uri): Bitmap? = try {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= 1280 || bounds.outHeight / (sample * 2) >= 1280) sample *= 2
        cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
    } catch (_: Exception) {
        null
    }

    /** One page as PNG, or every page in one PDF (1920×1080 each), in the app cache; returns a shareable uri. */
    fun export(ctx: Context, pages: List<Bitmap>, pdf: Boolean, pageNo: Int): Uri {
        val dir = File(ctx.cacheDir, "exports").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() } // only the latest export is kept
        val file = File(dir, if (pdf) "whiteboard.pdf" else "whiteboard-page-$pageNo.png")
        if (pdf) {
            val doc = PdfDocument()
            try {
                pages.forEachIndexed { i, bmp ->
                    val page = doc.startPage(PdfDocument.PageInfo.Builder(Wb.PAGE_W, Wb.PAGE_H, i + 1).create())
                    page.canvas.drawBitmap(bmp, 0f, 0f, null)
                    doc.finishPage(page)
                }
                file.outputStream().use { doc.writeTo(it) }
            } finally {
                doc.close()
            }
        } else {
            file.outputStream().use { pages.first().compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        return FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", file)
    }

    fun shareIntent(uri: Uri, pdf: Boolean): Intent = Intent(Intent.ACTION_SEND).apply {
        type = if (pdf) "application/pdf" else "image/png"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
}
