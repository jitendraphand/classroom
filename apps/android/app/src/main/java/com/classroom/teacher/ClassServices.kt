package com.classroom.teacher

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps the teacher's microphone and camera live while the app is in the
 * background (e.g. while sharing another app's screen). Since Android 11 an
 * app may only record audio / use the camera in the background from a
 * foreground service of type "microphone" / "camera"; Android 14+ also needs
 * FOREGROUND_SERVICE_MICROPHONE / _CAMERA and the service must be started
 * while the app is visible with the runtime permission granted, which is when
 * the teacher turns the microphone or camera on.
 *
 * Started with [EXTRA_MIC] / [EXTRA_CAMERA]; types are re-declared on every
 * start so turning one off drops it. Stopped when neither is on.
 */
class ClassAudioService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val mic = intent?.getBooleanExtra(EXTRA_MIC, false) ?: false
        val camera = intent?.getBooleanExtra(EXTRA_CAMERA, false) ?: false
        if (!mic && !camera) {
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }
        val notification = Notifications.inClass(this)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                var type = 0
                if (mic) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                if (camera) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                startForeground(Notifications.AUDIO_ID, notification, type)
            } else {
                startForeground(Notifications.AUDIO_ID, notification)
            }
        } catch (e: Exception) {
            // Not allowed right now (e.g. started from the background): mic and
            // camera still work while the app is on screen.
            android.util.Log.w("ClassAudioService", "startForeground failed", e)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    companion object {
        const val EXTRA_MIC = "mic"
        const val EXTRA_CAMERA = "camera"
    }
}

/** "Stop sharing" on the screen-share notification. */
class ShareStopReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        onStopRequested?.invoke()
    }

    companion object {
        const val ACTION_STOP = "com.classroom.teacher.STOP_SHARE"

        /** Set by MainActivity while it is alive. */
        @Volatile
        var onStopRequested: (() -> Unit)? = null
    }
}

object Notifications {
    const val SHARE_ID = 41
    const val WAITING_ID = 42
    const val AUDIO_ID = 43
    private const val SHARE_CHANNEL = "classroom_screen_share"
    private const val AUDIO_CHANNEL = "classroom_in_class"
    const val WAITING_CHANNEL = "classroom_waiting"

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val m = context.getSystemService(NotificationManager::class.java)
        m.createNotificationChannel(NotificationChannel(SHARE_CHANNEL, "Screen share", NotificationManager.IMPORTANCE_LOW))
        m.createNotificationChannel(NotificationChannel(AUDIO_CHANNEL, "In class", NotificationManager.IMPORTANCE_LOW))
        m.createNotificationChannel(NotificationChannel(WAITING_CHANNEL, "Waiting students", NotificationManager.IMPORTANCE_HIGH))
    }

    private fun openApp(context: Context, stopShare: Boolean = false): PendingIntent = PendingIntent.getActivity(
        context,
        if (stopShare) 2 else 0,
        Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            .putExtra(MainActivity.EXTRA_STOP_SHARE, stopShare),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    /** Shown by LiveKit's screen-capture foreground service (type mediaProjection). */
    fun screenShare(context: Context): Notification {
        ensureChannels(context)
        val stop = PendingIntent.getBroadcast(
            context,
            1,
            Intent(context, ShareStopReceiver::class.java).setAction(ShareStopReceiver.ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(context, SHARE_CHANNEL)
            .setContentTitle(context.getString(R.string.share_notification_title))
            .setContentText(context.getString(R.string.share_notification_text))
            .setSmallIcon(R.drawable.ic_stat_share)
            // Tapping the notification = back to the class and stop sharing
            // (the fallback when the floating bubble cannot be shown).
            .setContentIntent(openApp(context, stopShare = true))
            .setOngoing(true)
            .addAction(0, context.getString(R.string.share_notification_return), openApp(context, stopShare = true))
            .addAction(0, context.getString(R.string.share_notification_stop), stop)
            .build()
    }

    fun inClass(context: Context): Notification {
        ensureChannels(context)
        return NotificationCompat.Builder(context, AUDIO_CHANNEL)
            .setContentTitle(context.getString(R.string.audio_notification_title))
            .setContentText(context.getString(R.string.audio_notification_text))
            .setSmallIcon(R.drawable.ic_stat_share)
            .setContentIntent(openApp(context))
            .setOngoing(true)
            .build()
    }

    fun waiting(context: Context, text: String): Notification {
        ensureChannels(context)
        return NotificationCompat.Builder(context, WAITING_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_share)
            .setContentTitle(context.getString(R.string.waiting_notification_title))
            .setContentText(text)
            .setContentIntent(openApp(context))
            .setAutoCancel(true)
            .build()
    }
}
