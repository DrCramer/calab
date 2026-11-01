/**
 * Where the RNNoise worklet may run (board #114, docs/02 «Нет двойной обработки»).
 *
 * RNNoise is only useful on the raw capture: on top of another noise suppressor it removes no
 * further noise and distorts speech, worst at phrase onsets / offsets (the «gurgle», measured
 * offline: +5–6 dB speech error at the edges, the same residual noise in pauses). So it runs
 * only where the capture's own NS can be switched off:
 *
 *  - WebKit (iPhone Safari, the iOS shell's WKWebView, Safari on macOS) has no `noiseSuppression`
 *    constraint (`getSupportedConstraints()` lists only `echoCancellation`): with AEC on, Apple's
 *    voice processing keeps its own NS whatever we ask — RNNoise would always be a second pass;
 *  - Android (browser and shell): echo-cancelled capture uses the VOICE_COMMUNICATION source, whose
 *    OEM pre-processing keeps NS on many devices, and a phone CPU has no headroom for 100 WASM
 *    frames/s on the audio thread. The platform NS is used instead.
 *
 * The synced pref (`prefs.rnnoise`, profile `noiseSuppression`) is left as is: it still applies on
 * the user's desktop. Here the toggle shows off and disabled with a short reason.
 */
export interface RnnoiseEnv {
  /** `navigator.mediaDevices.getSupportedConstraints().noiseSuppression`. */
  noiseSuppressionConstraint: boolean;
  userAgent: string;
}

export function rnnoiseSupportedIn(env: RnnoiseEnv): boolean {
  return env.noiseSuppressionConstraint && !/\bAndroid\b/i.test(env.userAgent);
}

let cached: boolean | undefined;

/** This window can run RNNoise (constant for the page's life). */
export function rnnoiseSupported(): boolean {
  if (cached === undefined) {
    const md = typeof navigator === 'undefined' ? undefined : (navigator.mediaDevices as MediaDevices | undefined);
    // No mediaDevices (an insecure context, Node tests): no capture at all, nothing to decide here.
    cached =
      md === undefined || typeof md.getSupportedConstraints !== 'function'
        ? true
        : rnnoiseSupportedIn({ noiseSuppressionConstraint: md.getSupportedConstraints().noiseSuppression === true, userAgent: navigator.userAgent });
  }
  return cached;
}

/** Tests only. */
export function resetRnnoiseSupportForTests(): void {
  cached = undefined;
}
