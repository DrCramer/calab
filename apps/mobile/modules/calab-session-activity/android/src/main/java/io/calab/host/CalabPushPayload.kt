package io.calab.host

import java.util.UUID

/**
 * The server's FCM data (apps/server/internal/push, `fcmData`): opaque routing references plus,
 * for messages, the alert text the server already reduced per ADR-0072. Nothing here is
 * authority — a tap only hands the references back to the web, which resolves them under its own
 * session (`POST /api/me/push-resolve`).
 */
internal data class CalabPushPayload(
  val kind: String,
  val binding: String,
  val eventId: String,
  val expiresAt: Long,
  val silent: Boolean,
  val missedCall: Boolean,
  val title: String?,
  val subtitle: String?,
  val body: String?,
  val callerName: String?,
  val conversationId: String?,
  val avatarJpeg: String?,
) {
  companion object {
    /** `call-cancel` stops a ring this device shows for that event ID (ADR-0071, Android). */
    const val CALL_CANCEL = "call-cancel"
    private val kinds = setOf("message", "call", "task", "calendar", CALL_CANCEL)

    fun uuid(value: String?): Boolean {
      if (value == null || value.length != 36) return false
      return try {
        UUID.fromString(value).let { it.mostSignificantBits != 0L || it.leastSignificantBits != 0L }
      } catch (_: IllegalArgumentException) {
        false
      }
    }

    private fun text(value: String?, limit: Int): String? =
      value?.trim()?.takeIf { it.isNotEmpty() }?.let { if (it.length > limit) it.take(limit) else it }

    fun parse(data: Map<String, String>, now: Long): CalabPushPayload? {
      val kind = data["kind"]
      val expires = data["expiresAt"]?.toLongOrNull()
      if (data["v"] != "1" || kind !in kinds || !uuid(data["binding"]) || !uuid(data["eventId"]) || expires == null || expires <= now) return null
      return CalabPushPayload(
        kind = kind!!,
        binding = data["binding"]!!.lowercase(),
        eventId = data["eventId"]!!.lowercase(),
        expiresAt = expires,
        silent = data["silent"] == "true",
        missedCall = data["missedCall"] == "true",
        title = text(data["title"], 120),
        subtitle = text(data["subtitle"], 120),
        body = text(data["body"], 320),
        callerName = text(data["callerName"], 120),
        conversationId = data["conversationId"]?.takeIf { Regex("^[0-9a-f]{64}$").matches(it) },
        avatarJpeg = data["avatarJpeg"]?.takeIf { it.length <= 4096 },
      )
    }
  }
}
