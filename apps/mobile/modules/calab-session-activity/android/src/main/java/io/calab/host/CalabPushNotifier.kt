package io.calab.host

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Presents data-only FCM pushes (ADR-0070/0071/0072, Android). Text comes only from the server's
 * payload (already reduced per the recipient's preview setting) or fixed local strings; a tap
 * carries only the opaque binding/event/expiry back to the web. In the foreground the shared
 * renderer owns sounds and alerts, so nothing is shown (as iOS suppresses foreground alerts).
 */
internal object CalabPushNotifier {
  private const val MESSAGES = "calab.messages"
  private const val CALLS = "calab.calls"
  private const val CALL_TAG = "calab.call"
  private const val TEST_TAG = "calab.test"
  private const val ACCENT = 0xFF0071E3.toInt()

  private fun channels(context: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    manager.createNotificationChannel(NotificationChannel(MESSAGES, context.getString(R.string.calab_push_channel_messages), NotificationManager.IMPORTANCE_HIGH))
    val ring = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
    manager.createNotificationChannel(NotificationChannel(CALLS, context.getString(R.string.calab_push_channel_calls), NotificationManager.IMPORTANCE_HIGH).apply {
      setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), ring)
      enableVibration(true)
      vibrationPattern = longArrayOf(0, 800, 800)
    })
  }

  private fun builder(context: Context, channel: String): NotificationCompat.Builder =
    NotificationCompat.Builder(context, channel).setSmallIcon(R.drawable.calab_notification).setColor(ACCENT)

  private fun open(context: Context, payload: CalabPushPayload?, action: String?): PendingIntent {
    val intent = Intent(context, CalabPushOpenActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (payload != null) {
      intent.putExtra(CalabPushOpenActivity.BINDING, payload.binding)
        .putExtra(CalabPushOpenActivity.EVENT, payload.eventId)
        .putExtra(CalabPushOpenActivity.EXPIRES, payload.expiresAt)
        .putExtra(CalabPushOpenActivity.KIND, payload.kind)
      if (action != null) intent.putExtra(CalabPushOpenActivity.ACTION, action)
    }
    // Distinct per event and button, so extras of one notification never replace another's.
    val request = ((payload?.eventId ?: "").hashCode() * 31) + (action ?: "").hashCode()
    return PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  @SuppressLint("MissingPermission")
  private fun post(context: Context, tag: String, notification: Notification): Boolean {
    val manager = NotificationManagerCompat.from(context)
    if (CalabPush.permission(context) != "granted") return false
    return try {
      manager.notify(tag, 0, notification)
      true
    } catch (_: SecurityException) {
      false
    }
  }

  fun show(context: Context, payload: CalabPushPayload) {
    // A missed-call message ends any ring this device still shows.
    if (payload.kind != "call" && payload.missedCall) cancelCall(context)
    if (CalabPush.foreground()) return
    channels(context)
    if (payload.kind == "call") return showCall(context, payload)
    val generic = context.getString(R.string.calab_push_new_notification)
    val title = if (payload.kind == "message") payload.title else null
    val body = if (payload.kind == "message" && title != null) payload.body ?: generic else generic
    val builder = builder(context, MESSAGES)
      .setContentTitle(title ?: context.getString(R.string.calab_push_app_name))
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setSilent(payload.silent)
      .setWhen(System.currentTimeMillis())
      // Only a message reference resolves to a screen (as on iOS); other kinds just open the app.
      .setContentIntent(open(context, payload.takeIf { it.kind == "message" }, null))
    payload.subtitle?.let { builder.setSubText(it) }
    avatar(payload)?.let { builder.setLargeIcon(it) }
    // One visible notification per conversation (opaque per-binding ID), else per event.
    post(context, "calab.message." + (payload.conversationId ?: payload.eventId), builder.build())
  }

  private fun showCall(context: Context, payload: CalabPushPayload) {
    val remaining = payload.expiresAt - System.currentTimeMillis()
    if (remaining <= 0) return
    // Heads-up with ringtone until answered, declined, cancelled by the app or the server's ring expiry.
    // A lock-screen call UI (ConnectionService / full-screen intent) is v2 (ADR-0071, Android).
    val notification = builder(context, CALLS)
      .setContentTitle(payload.callerName ?: context.getString(R.string.calab_push_app_name))
      .setContentText(context.getString(R.string.calab_push_incoming_call))
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setOngoing(true)
      .setAutoCancel(true)
      .setTimeoutAfter(remaining)
      .setContentIntent(open(context, payload, null))
      .addAction(0, context.getString(R.string.calab_push_decline), open(context, payload, "decline"))
      .addAction(0, context.getString(R.string.calab_push_answer), open(context, payload, "answer"))
      .apply { avatar(payload)?.let { setLargeIcon(it) } }
      .build()
    notification.flags = notification.flags or Notification.FLAG_INSISTENT
    // One ringing call at a time: a newer ring replaces the previous one (server keeps one live call).
    // The tag names the ring's opaque event ID, so the server's `call-cancel` removes only this ring.
    cancelCall(context)
    post(context, callTag(payload.eventId), notification)
  }

  fun showTest(context: Context, body: String): Boolean {
    channels(context)
    val notification = builder(context, MESSAGES)
      .setContentTitle(context.getString(R.string.calab_push_app_name))
      .setContentText(body)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setContentIntent(open(context, null, null))
      .build()
    return post(context, TEST_TAG, notification)
  }

  private fun callTag(eventId: String) = "$CALL_TAG.$eventId"

  /** Any ring this device shows (answer/decline tap, app foreground, missed-call message). */
  fun cancelCall(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    try {
      for (shown in manager.activeNotifications) if (shown.tag?.startsWith("$CALL_TAG.") == true) manager.cancel(shown.tag, shown.id)
    } catch (_: RuntimeException) {
      // activeNotifications is best effort on some OEM builds; the ring's own timeout still ends it.
    }
  }

  /** The server's `call-cancel`: only the ring with this event ID; a newer ring stays. */
  fun cancelRing(context: Context, eventId: String) = NotificationManagerCompat.from(context).cancel(callTag(eventId), 0)

  /** Logout: NotificationManager scopes this to Calab's own notifications. */
  fun clearAll(context: Context) = NotificationManagerCompat.from(context).cancelAll()

  private fun avatar(payload: CalabPushPayload) = payload.avatarJpeg?.let {
    try {
      val bytes = Base64.decode(it, Base64.DEFAULT)
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    } catch (_: IllegalArgumentException) {
      null
    }
  }
}
