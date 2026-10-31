package io.calab.host

import android.Manifest
import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import expo.modules.interfaces.permissions.Permissions
import java.util.UUID

/**
 * Android counterpart of CalabMessagePush (CalabMessageNotificationsModule.swift), ADR-0070
 * Android. Everything runs on the main looper. The document authority comes from the RN host
 * (App.tsx), which grants it after the hello of a main-frame message of the exact app origin
 * (the react-native-webview patch drops everything else natively) and revokes it on every
 * navigation, reload, remount and logout; no Calab auth reaches native.
 */
internal object CalabPush {
  private const val PREFS = "calab.push"
  private const val INSTALLATION = "installation"
  private const val ASKED = "permissionRequested"
  private const val TOKEN_DEADLINE_MS = 10_000L

  private val main = Handler(Looper.getMainLooper())
  private var context: Context? = null
  private var document: String? = null
  private var token: String? = null
  private val registrationRetry = CalabPushRetry()
  private var pendingTap: Map<String, Any>? = null
  private val waiters = mutableListOf<Pair<String, (String?) -> Unit>>()
  private var requestingToken = false
  private var testing = false

  /** Set by the module while React runs; the messaging service works without it. */
  var emit: ((String, Map<String, Any>) -> Unit)? = null

  fun install(context: Context) = onMain { this.context = context.applicationContext }

  private fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
  }

  private fun current(document: String): Boolean = this.document == document

  /** The default FirebaseApp exists only when the build carried google-services.json. */
  fun configured(context: Context): Boolean = try {
    FirebaseApp.getApps(context).isNotEmpty()
  } catch (_: Exception) {
    false
  }

  fun foreground(): Boolean {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }

  private fun installation(context: Context): String {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    prefs.getString(INSTALLATION, null)?.takeIf { CalabPushPayload.uuid(it) }?.let { return it }
    val value = UUID.randomUUID().toString()
    prefs.edit().putString(INSTALLATION, value).apply()
    return value
  }

  /** iOS `UNAuthorizationStatus` semantics: `default` only until Calab asked once (Android cannot tell). */
  fun permission(context: Context): String {
    val enabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
    if (Build.VERSION.SDK_INT >= 33) {
      val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
      if (granted) return if (enabled) "granted" else "denied"
      return if (context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ASKED, false)) "denied" else "default"
    }
    return if (enabled) "granted" else "denied"
  }

  private fun ask(context: Context, permissions: Permissions?, done: () -> Unit) {
    if (Build.VERSION.SDK_INT < 33 || permissions == null || !foreground()) return done()
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(ASKED, true).apply()
    try {
      permissions.askForPermissions({ main.post(done) }, Manifest.permission.POST_NOTIFICATIONS)
    } catch (_: Exception) {
      done()
    }
  }

  fun grant(document: String) = onMain {
    if (!CalabPushPayload.uuid(document)) return@onMain
    if (this.document != document) { this.document = document }
  }

  /** Navigation/reload invalidates the document; `logout` also forgets the cold tap and our notifications. */
  fun revoke(logout: Boolean) = onMain {
    document = null
    token = null
    finishToken(null)
    if (logout) {
      pendingTap = null
      context?.let { CalabPushNotifier.clearAll(it) }
    }
  }

  fun state(document: String, requestPermission: Boolean, permissions: Permissions?, reply: (Map<String, Any>) -> Unit) = onMain {
    val context = context
    val unsupported = mapOf<String, Any>("permission" to "unsupported")
    if (context == null || !current(document) || !configured(context)) return@onMain reply(unsupported)
    if (requestPermission) registrationRetry.retry(System.currentTimeMillis())
    val proceed = proceed@{
      if (!current(document)) return@proceed reply(unsupported)
      when (val permission = permission(context)) {
        "granted" -> deviceToken(document) { value ->
          if (value == null || !current(document)) reply(unsupported)
          else reply(withTap(mapOf("permission" to "granted", "provider" to "fcm", "token" to value, "appId" to context.packageName,
            "environment" to "production", "installationId" to installation(context))))
        }
        else -> reply(withTap(mapOf("permission" to permission)))
      }
    }
    if (requestPermission && permission(context) == "default") ask(context, permissions, proceed) else proceed()
  }

  private fun withTap(value: Map<String, Any>): Map<String, Any> {
    val tap = pendingTap
    val expires = (tap?.get("expiresAt") as? Double)?.toLong()
    if (tap == null || expires == null || expires <= System.currentTimeMillis()) { pendingTap = null; return value }
    return value + ("tap" to tap)
  }

  fun test(document: String, body: String, permissions: Permissions?, reply: (String) -> Unit) = onMain {
    val context = context
    if (context == null || !current(document) || !configured(context)) return@onMain reply("unsupported")
    if (testing || !foreground() || body.isBlank() || body.length > 512) return@onMain reply("failed")
    testing = true
    val finish = { result: String -> testing = false; reply(result) }
    val show = show@{
      if (!current(document) || !foreground()) return@show finish("failed")
      if (permission(context) != "granted") return@show finish("denied")
      // A local banner only: proves permission and presentation, not FCM delivery (ADR-0070).
      finish(if (CalabPushNotifier.showTest(context, body)) "scheduled" else "failed")
    }
    if (permission(context) == "default") ask(context, permissions, show) else show()
  }

  fun acknowledge(document: String, eventId: String) = onMain {
    if (!current(document) || pendingTap?.get("eventId") != eventId) return@onMain
    pendingTap = null
  }

  /** A notification tap (CalabPushOpenActivity). Only a message or call reference is kept, as on iOS. */
  fun tapped(binding: String, eventId: String, expiresAt: Long, action: String?) = onMain {
    if (!CalabPushPayload.uuid(binding) || !CalabPushPayload.uuid(eventId) || expiresAt <= System.currentTimeMillis()) return@onMain
    val tap = mutableMapOf<String, Any>("binding" to binding, "eventId" to eventId, "expiresAt" to expiresAt.toDouble())
    if (action == "answer" || action == "decline") tap["action"] = action
    pendingTap = tap
    publish()
  }

  /** Foreground return re-probes once (a failed registration may retry; iOS `refresh`). */
  fun refresh() = onMain {
    if (document == null) return@onMain
    registrationRetry.retry(System.currentTimeMillis())
    publish()
  }

  private fun publish() {
    val document = document ?: return
    state(document, false, null) { value -> if (current(document)) emit?.invoke(document, value) }
  }

  private fun deviceToken(document: String, done: (String?) -> Unit) {
    val context = context
    if (context == null || !current(document) || !configured(context) || !registrationRetry.canAttempt) return done(null)
    token?.let { return done(it) }
    val waiter = document to done
    waiters.add(waiter)
    if (!requestingToken) {
      requestingToken = true
      try {
        // firebase-messaging 26 deprecates getToken()/onNewToken for register()/onRegistered; the
        // token-returning call keeps the iOS-shaped request/deadline flow. Migrate with the next BOM.
        @Suppress("DEPRECATION")
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
          val value = if (task.isSuccessful) task.result else null
          main.post { if (value.isNullOrEmpty()) registrationFailed() else registered(value) }
        }
      } catch (_: Exception) {
        registrationFailed()
      }
    }
    // Only a pending registration has a deadline; no idle polling or background keepalive.
    main.postDelayed({
      if (waiters.remove(waiter)) waiter.second(null)
      if (waiters.isEmpty()) requestingToken = false
    }, TOKEN_DEADLINE_MS)
  }

  private fun finishToken(value: String?) {
    val waiting = waiters.toList()
    waiters.clear()
    requestingToken = false
    for ((document, done) in waiting) done(if (current(document)) value else null)
  }

  /** A fetched or refreshed (`onNewToken`) token; a change re-registers through the web channel. */
  fun registered(value: String) = onMain {
    val changed = token != value
    token = value
    registrationRetry.succeeded()
    finishToken(value)
    if (changed) publish()
  }

  private fun registrationFailed() {
    registrationRetry.failed(System.currentTimeMillis())
    token = null
    finishToken(null)
  }
}
