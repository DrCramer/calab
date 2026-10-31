export type Os = 'mac' | 'win' | 'linux';

type NavigatorUAData = Navigator & { userAgentData?: { platform?: string } };

/** Desktop OS of the visitor; null for phones, tablets, ChromeOS and anything unrecognised. */
export function detectOs(): Os | null {
  const nav = navigator as NavigatorUAData;
  const platform = (nav.userAgentData?.platform ?? '').toLowerCase();
  const ua = nav.userAgent;
  // iPadOS reports a Mac UA ("Macintosh") but has a touch screen.
  if (/Android|iPhone|iPad|iPod|CrOS/.test(ua) || platform === 'android' || platform === 'chrome os') return null;
  if (platform.startsWith('mac') || /Macintosh|Mac OS X/.test(ua)) return nav.maxTouchPoints > 1 ? null : 'mac';
  if (platform.startsWith('win') || ua.includes('Windows')) return 'win';
  if (platform === 'linux' || /Linux|X11/.test(ua)) return 'linux';
  return null;
}

export type MacArch = 'arm' | 'intel';

type NavigatorArch = Navigator & {
  userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> };
};

/**
 * A Mac's CPU, best effort: Chromium's UA client hints, else the WebGL renderer ("Apple M…" vs Intel/AMD GPUs).
 * Safari masks the renderer as "Apple GPU" on both, so it stays null there (the caller defaults to Apple Silicon).
 */
export async function detectMacArch(): Promise<MacArch | null> {
  try {
    const hints = await (navigator as NavigatorArch).userAgentData?.getHighEntropyValues?.(['architecture']);
    if (hints?.architecture === 'arm') return 'arm';
    if (hints?.architecture === 'x86') return 'intel';
  } catch {
    // No client hints: fall through to WebGL.
  }
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    if (/Apple M\d/.test(renderer)) return 'arm';
    if (/Intel|AMD|Radeon|NVIDIA/i.test(renderer)) return 'intel';
  } catch {
    // No WebGL: unknown.
  }
  return null;
}
