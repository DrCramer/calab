import { describe, expect, it } from 'vitest';
import { rnnoiseSupportedIn } from './rnnoiseSupport';

const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';
const WEBVIEW_ANDROID = 'Mozilla/5.0 (Linux; Android 13; SM-A145F; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.0.0 Mobile Safari/537.36';

describe('rnnoiseSupportedIn', () => {
  it('runs where the capture NS can be switched off (desktop Chromium / Electron, Firefox)', () => {
    expect(rnnoiseSupportedIn({ noiseSuppressionConstraint: true, userAgent: CHROME_MAC })).toBe(true);
  });

  it('not on WebKit: no noiseSuppression constraint, Apple voice processing keeps its NS', () => {
    expect(rnnoiseSupportedIn({ noiseSuppressionConstraint: false, userAgent: SAFARI_IPHONE })).toBe(false);
  });

  it('not on Android, browser or shell WebView: platform NS, no CPU headroom', () => {
    expect(rnnoiseSupportedIn({ noiseSuppressionConstraint: true, userAgent: CHROME_ANDROID })).toBe(false);
    expect(rnnoiseSupportedIn({ noiseSuppressionConstraint: true, userAgent: WEBVIEW_ANDROID })).toBe(false);
  });
});
