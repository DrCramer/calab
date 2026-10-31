package io.calab.host

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The CalabMessageNotifications contract of iOS (`pushState`, `acknowledgePush`,
 * `testNotification`, `onPushChanged`) over FCM, plus the document grant that the iOS WebView
 * patch posts natively and the RN host passes here (`setDocument`; null revokes). The RN host
 * learns the document only from messages the patched WebMessageListener delivered: main frame,
 * exact app origin (ADR-0070, Android).
 */
class CalabMessageNotificationsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CalabMessageNotifications")
    Events("onPushChanged")
    OnCreate {
      appContext.reactContext?.let { CalabPush.install(it) }
      CalabPush.emit = { document, state -> sendEvent("onPushChanged", mapOf("document" to document, "state" to state)) }
    }
    OnDestroy { CalabPush.emit = null }
    OnActivityEntersForeground {
      appContext.reactContext?.let { CalabPushNotifier.cancelCall(it) }
      CalabPush.refresh()
    }
    Function("setDocument") { document: String?, logout: Boolean ->
      if (document == null) CalabPush.revoke(logout) else CalabPush.grant(document)
    }
    AsyncFunction("pushState") { document: String, requestPermission: Boolean, promise: Promise ->
      CalabPush.state(document, requestPermission, appContext.permissions) { promise.resolve(it) }
    }
    AsyncFunction("acknowledgePush") { document: String, eventId: String -> CalabPush.acknowledge(document, eventId) }
    AsyncFunction("testNotification") { document: String, body: String, promise: Promise ->
      CalabPush.test(document, body, appContext.permissions) { promise.resolve(it) }
    }
  }
}
