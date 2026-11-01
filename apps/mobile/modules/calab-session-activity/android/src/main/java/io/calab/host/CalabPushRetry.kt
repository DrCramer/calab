package io.calab.host

/** Retries are triggered by foreground/user intent, never by status probes or a timer (CalabPushRetry.swift). */
internal class CalabPushRetry {
  private var retryAt: Long? = null
  val canAttempt: Boolean get() = retryAt == null
  fun failed(now: Long) { retryAt = now + 15_000 }
  fun succeeded() { retryAt = null }
  fun retry(now: Long) {
    val at = retryAt
    if (at != null && now >= at) retryAt = null
  }
}
