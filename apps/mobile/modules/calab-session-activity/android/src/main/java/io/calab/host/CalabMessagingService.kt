package io.calab.host

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** FCM entry point; runs with or without React (a cold process starts only this service). */
class CalabMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val payload = CalabPushPayload.parse(message.data, System.currentTimeMillis()) ?: return
    // A ring that ended early: remove only the notification of that ring (opaque event ID).
    if (payload.kind == CalabPushPayload.CALL_CANCEL) return CalabPushNotifier.cancelRing(applicationContext, payload.eventId)
    CalabPushNotifier.show(applicationContext, payload)
  }

  /** Token rotation; re-registration goes through the web channel (`onPushChanged`). */
  @Deprecated("firebase-messaging 26: onRegistered; kept with getToken() in CalabPush")
  override fun onNewToken(token: String) = rotated(token)

  /** firebase-messaging 26 reports registrations here as well. */
  override fun onRegistered(token: String) = rotated(token)

  private fun rotated(token: String) {
    CalabPush.install(applicationContext)
    CalabPush.registered(token)
  }
}
