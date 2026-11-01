package io.calab.host

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Notification trampoline (an Activity, so allowed on Android 12+): records the opaque tap for the
 * web channel and brings the app's own task forward exactly like the launcher icon would. It does
 * not touch MainActivity's intents; the web resolves the reference under its session.
 */
class CalabPushOpenActivity : Activity() {
  companion object {
    const val BINDING = "io.calab.host.binding"
    const val EVENT = "io.calab.host.event"
    const val EXPIRES = "io.calab.host.expires"
    const val KIND = "io.calab.host.kind"
    const val ACTION = "io.calab.host.action"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val extras = intent?.extras ?: Bundle.EMPTY
    val binding = extras.getString(BINDING)
    val event = extras.getString(EVENT)
    val kind = extras.getString(KIND)
    CalabPush.install(applicationContext)
    if (kind == "call") CalabPushNotifier.cancelCall(applicationContext)
    if (binding != null && event != null && (kind == "message" || kind == "call"))
      CalabPush.tapped(binding, event, extras.getLong(EXPIRES, 0L), if (kind == "call") extras.getString(ACTION) else null)
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
      startActivity(it)
    }
    finish()
  }
}
