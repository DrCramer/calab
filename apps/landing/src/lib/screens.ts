// Screenshot sizes in CSS px (= the crops of scripts/assets.mjs, which `--check`s them against this table; the @2x file is
// twice as large). Files: public/screens/<lang>/<name>.webp and <name>@2x.webp, the app and its team in that language;
// a scene wider than 720 px also has <name>-720.webp, and one with `focus` (≤ 720 px, the main panel without the rail and
// the sidebar, for phones) <name>-focus.webp and <name>-focus@2x.webp.
export const SCREENS = {
  voice: { width: 1440, height: 900, focus: { width: 720, height: 560 } },
  // landing v6
  'chat-full': { width: 1440, height: 900, focus: { width: 720, height: 560 } },
  'kanban-full': { width: 1440, height: 900, focus: { width: 720, height: 560 } },
  'calendar-week': { width: 1440, height: 900, focus: { width: 720, height: 560 } },
  'phone-call': { width: 1440, height: 900, focus: { width: 720, height: 548 } },
  'phone-incoming': { width: 1440, height: 900, focus: { width: 720, height: 560 } },
  'story-incoming': { width: 760, height: 440 },
  'mail-window': { width: 1440, height: 758, focus: { width: 720, height: 560 } },
  'disk-full': { width: 1056, height: 660, focus: { width: 720, height: 560 } },
  'telephony-ivr': { width: 698, height: 330 },
  'telephony-groups': { width: 698, height: 330 },
  'telephony-call': { width: 698, height: 330 },
  roles: { width: 698, height: 338 },
  'recording-focus': { width: 860, height: 538 },
  'recording-transcript': { width: 860, height: 230 },
  aitask: { width: 576, height: 440 },
  rail: { width: 72, height: 560 },
  'story-message': { width: 860, height: 420 },
  'story-task': { width: 860, height: 860 },
  'story-meeting': { width: 320, height: 560 },
  'story-wiki': { width: 720, height: 520 },
  'phone-canvas': { width: 390, height: 844 },
  canvas: { width: 1440, height: 900, focus: { width: 720, height: 560 } },
  'canvas-panel': { width: 860, height: 538 },
  'wiki-full': { width: 1440, height: 900, focus: { width: 720, height: 560 } },
  chat: { width: 1040, height: 762 },
  call: { width: 1440, height: 870 },
  calendar: { width: 1110, height: 870 },
  findtime: { width: 1110, height: 870 },
  kanban: { width: 1110, height: 600 },
  timeline: { width: 1110, height: 870, focus: { width: 720, height: 560 } },
  task: { width: 510, height: 870 },
  guest: { width: 600, height: 460 },
  sipdial: { width: 1110, height: 300 },
  siproom: { width: 1440, height: 500 },
  sipsettings: { width: 940, height: 660 },
  siplog: { width: 940, height: 660 },
  webapps: { width: 1440, height: 870 },
  checklists: { width: 480, height: 870 },
  boardfeatures: { width: 940, height: 660 },
  boardhook: { width: 940, height: 660 },
  sso: { width: 940, height: 660 },
  ssopolicy: { width: 940, height: 660 },
  consent: { width: 560, height: 480 },
  stickerchat: { width: 1110, height: 870 },
  stickerpicker: { width: 1110, height: 870 },
  voicelist: { width: 340, height: 440 },
  // Landing 3.3 (e2e-marketing/landing-v5.spec.ts, landing-mail.spec.ts)
  mail: { width: 1440, height: 758, focus: { width: 381, height: 560 } },
  taskhistory: { width: 1110, height: 870 },
  notify: { width: 920, height: 640 },
  notifyrelay: { width: 920, height: 640 },
  gallery: { width: 860, height: 504 },
  disk: { width: 990, height: 570 },
  wiki: { width: 990, height: 750 },
  search: { width: 660, height: 650 },
  'phone-rooms': { width: 390, height: 844 },
  'phone-chat': { width: 390, height: 844 },
  'phone-voice': { width: 390, height: 844 },
  'phone-board': { width: 390, height: 844 },
  // landing v6 catalogue tiles cut out of the scenes above (≤ 860 px wide: ≥ 0.66 in a 568 px tile)
  'disk-panel': { width: 860, height: 513 },
} as const;

/** The screens that have a phone crop (<name>-focus.webp). */
export type FocusScreenName = {
  [K in keyof typeof SCREENS]: (typeof SCREENS)[K] extends { focus: unknown } ? K : never;
}[keyof typeof SCREENS];

export type ScreenName = keyof typeof SCREENS;

/**
 * Whole-window captures (the macOS window, `screencapture -o`): the file carries the native corners as transparent
 * pixels, so the page draws no rounded frame of its own around them (Shot → .shot-window). Their phone crops have
 * no corners and keep the usual frame.
 */
// aitask: its committed files are masked to the dialog's rounded shape (transparent outside), so it shows frameless too.
const WINDOWS: ReadonlySet<ScreenName> = new Set<ScreenName>(['voice', 'chat-full', 'kanban-full', 'calendar-week', 'mail', 'mail-window', 'wiki-full', 'canvas', 'disk-full', 'phone-call', 'phone-incoming', 'aitask']);
export const isWindow = (name: ScreenName): boolean => WINDOWS.has(name);

/** The phone crop of a screen that has one (`<name>-focus.webp`), or undefined. */
export function focusOf(name: ScreenName): { width: number; height: number } | undefined {
  return (SCREENS[name] as { focus?: { width: number; height: number } }).focus;
}
