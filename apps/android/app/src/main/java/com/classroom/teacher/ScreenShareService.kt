package com.classroom.teacher

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CompletableDeferred

/**
 * Android requires a foreground service of type mediaProjection before
 * MediaProjection can capture the screen. The service is started after the
 * user accepts the system capture prompt and before LiveKit publishes.
 */
class ScreenShareService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            val stop = onStopRequested
            if (stop != null) {
                // The activity unpublishes the track, then stops this service.
                stop.invoke()
            } else {
                stopSelf()
            }
            return START_NOT_STICKY
        }
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        ready?.complete(Unit)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        ready?.cancel()
        ready = null
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Screen share",
                NotificationManager.IMPORTANCE_LOW,
            )
            manager.createNotificationChannel(channel)
        }
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, ScreenShareService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.share_notification_title))
            .setContentText(getString(R.string.share_notification_text))
            .setSmallIcon(R.drawable.ic_stat_share)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(0, getString(R.string.share_notification_stop), stop)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "classroom_screen_share"
        private const val NOTIFICATION_ID = 41
        const val ACTION_STOP = "com.classroom.teacher.STOP_SHARE"

        @Volatile
        var ready: CompletableDeferred<Unit>? = null

        /** Activity hook so Stop on the notification works while the app is in the background. */
        @Volatile
        var onStopRequested: (() -> Unit)? = null
    }
}
