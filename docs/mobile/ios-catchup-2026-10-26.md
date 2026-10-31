# iOS catch-up audit and implementation plan (2026-10-26)

## Contract

Bring the existing iOS host up to current Calab, retaining the shared renderer
(ADR-0067). Owner asked for audit, plan, Opus 5.5 plan review, implementation,
Opus 5.5 implementation review, and a factual report. Owner explicitly excluded
Mail: it will be connected separately on mobile. No replacement native UI.

Baseline: `e0018e108` (origin/main fetched 2026-10-26, latest change 2026-10-24).
Comparison: last recorded TestFlight source `08eba021` (0.1.0 build 20), plus
later permission correction `d5fdffb7` (Oct 9). This is source history, not a claim
about current App Store review or which binary a device has installed.

Work in the existing isolated mobile checkout on `codex/ios-parity-20261026`.
Preserve its pre-existing `.gitignore` change. The old React Native UI experiment
is frozen and is not the implementation to resume. No push, PR, release, live
provider calls, installation on the owner's phone, or production writes in this
local implementation task.

## Audit

The phone hosts the deployed web client: a binary does not embed desktop screens.
A web deployment/reload delivers shared features; native changes need a new binary.
There are 1115 upstream commits since the Oct 9 checkpoint, but only a handful
change the native host. A commit count is not a missing-feature count.

| Area since the previous build | Source evidence | Mobile outcome / acceptance |
| --- | --- | --- |
| Chat, DM, navigation, pinned tabs, unread counts | MobileShell, PhoneTabBar, lib/phoneNav, ADR-0073/0095 | Already shared; exercise roots, More, back, older saved preferences and room return |
| Boards, richer task editor, AI task creation | BoardsRoot, BoardsCreateMenu, SmartTaskDialog; ADR-0118/0123 | Already shared; check phone create menu, forms and editor, without paid AI calls |
| Calendar and event comments | CalendarRoot, DayView, EventPanel | Already shared; inspect day/event navigation and narrow layout |
| Disk, folders, previews, links and sharing | PhoneDisk, DiskViewer, services/disk; ADR-0094 | Already shared; inspect folder/file route, preview and download plumbing |
| Wiki, rich editor and page links | PhoneWiki, WikiEditor, PhoneToolbar; ADR-0096 | Already shared; repair editor open-link path described below |
| Canvas viewing/editing, comments, chat cards | PhoneCanvas/PhoneCanvasScreen, view/CanvasView; ADR-0126/0127 | Already shared; inspect edit mode, touch tools, back and card navigation |
| PBX, incoming phone calls, transfer and room suspension | services/sipInbound, features/call, ADR-0117/0132/0133 | Shared foreground controls; check phone layout and existing service tests; no paid calls |
| Permission requests, native notification test | hostActivity, native modules, PR140 sources now in main | Must be included in new native binary; verify old-host fallback and final compile |
| App Store billing policy | platform/nativeShell, ADR-0087 | Retain iOS purchase suppression and read-only entitlement/status views |
| Native runtime | apps/mobile/package.json, Expo bundledNativeModules.json | BROKEN dependency alignment: Expo57 expects RN0.86.3/React19.2.3; main declares RN0.88.0/React19.3.1 |
| Reproducible release identity | app.config.ts, extension plugins | Config always uses 0.1.0/build1; add validated env version/build inputs, matching extensions |
| Mail | ADR-0088, Electron utility process | EXCLUDED by owner for separate mobile connection |

### Confirmed gaps

1. `expo install --check` fails despite 125 mobile tests, 6 plugin tests and
   mobile typecheck passing. It reports React, ReactDOM, RN, React types and
   TypeScript mismatches (and a compatible SDK57 patch). CI checks TS and tests,
   but never verifies Expo dependency alignment or exports the native bundle.
2. The rich editor's phone link button and bubble link button call `window.open`
   directly. The host intentionally blocks same-origin new windows. Read-only
   editor content routes only Wiki-page links internally. Thus task/board/canvas/
   disk links embedded in the new shared editor can do nothing on iOS. Fix in the
   shared content layer, retaining the host's origin boundary and one WebView.
3. Version/build metadata is changed manually outside tracked config. A regenerated
   project can silently return to build 1. Main app and its extensions must share
   validated configuration; local builds must remain possible without production
   identity or APNs grants.

### Existing OS boundaries (not introduced by desktop evolution)

- Native audio is scoped to accepted incoming Calab calls; outgoing calls, voice
  rooms and new SIP calls still use the web media path. Existing source/unit
  evidence is not proof of background/locked audio for those paths.
- iOS screen broadcasting, system-audio capture and native PiP do not become
  supported by copying desktop code. The shared client capability-gates capture.
- Android origin/download hardening is separate; this request targets iOS.
- Old device reports are historical, not new hardware validation. Do all Mac,
  simulator and synthetic work before proposing a consequential physical check.

These boundaries must remain visible in the final report. This catch-up does not
claim universal desktop OS capability parity or silently re-open frozen native UI.

## Implementation

### 1. Restore an internally compatible Expo57 runtime

Files: apps/mobile/package.json, pnpm-lock.yaml, apps/mobile/metro.config.js,
.github/workflows/ci.yml; .github/dependabot.yml only if needed for runtime grouping.

- [x] Use the installed SDK's compatibility manifest and `expo install --check`;
  align SDK57 patch, React/ReactDOM19.2.3, RN0.86.3, types and TS6.0.3. Keep desktop
  React/TS independent. Do not upgrade SDK major or WebView/patched ABI.
- [x] Add `check:sdk` using Expo's offline dependency check and run it in CI after
  frozen install, plus a deterministic iOS export with a non-production test origin.
- [x] Verify frozen install, mobile types/lint/125+ tests/plugin tests, Expo config,
  compatible iOS export and unchanged desktop type safety. Inspect actual bundled
  React resolution, not just package manifests.

### 2. Make content links work across the shared phone UI

Files: features/wiki/editor/{PhoneToolbar,Menus,extensions,env,WikiEditor} as
needed, a small shared content-link helper and focused tests. Also inspect Disk
Markdown links for the same defect. No native allowlist widening.

- [x] Write failing behavior tests for the rich editor's internal task, board,
  disk and canvas links, Wiki page callback, external HTTPS, invalid schemes,
  same-origin lookalikes, and read-only vs editing clicks.
- [x] Use the existing `services/links.openOwnLink` for known application routes;
  preserve the editor's `PageSource.open` callback for wiki-page links. External
  safe links keep normal platform opening. Never replace the page for an internal
  link, join voice on navigation or bypass permissions.
- [x] Route phone/bubble/modifier/read-only activation through the same behavior;
  leave normal editing caret clicks alone and prevent duplicate opens.
- [x] Run focused editor/links tests, native navigation tests, renderer typecheck
  and lint. Check a phone-size editor with a real clickable internal route.

### 3. Reproducible binary identity and release checks

Files: apps/mobile/app.config.ts, src/config.{js,d.ts}, src/config.test.ts,
.env.example, plugin tests, docs/mobile release instructions.

- [x] Add `CALAB_APP_VERSION` (default 0.1.0) and `CALAB_IOS_BUILD_NUMBER` (default
  1) with strict validation. No signing, bundle IDs, hosts or provider credentials
  in source. Store builds require an explicit greater build number chosen from
  current distribution history at release time; do not infer live history from
  old notes or upload automatically.
- [x] Test default/valid/malformed identity and matching app/WidgetKit/notification
  extension version values after repeated prebuild. Preserve existing plugin
  idempotence and disabled-by-default APNs/call capabilities.
- [x] Prepare a new unsigned local Release with existing incoming-call native
  module enabled, plus simulator compilation/launch if tooling permits. Verify
  actual compiled metadata and embedded bundle; preserve existing signed artifacts.

### 4. Verify inherited feature coverage and report exact evidence

- [ ] Manual local synthetic 390px walkthrough: chat/DM, More pin/order, boards/task
  editor, calendar, disk/file, wiki/edit/link, canvas/edit, profile permissions.
  Check 375px and light theme for affected screens. Save screenshots. No broad
  screenshot-baseline rewrite or production mutations.
- [ ] Add focused regressions for any reproducible catch-up failure found; fix
  blocker/major within the shared UI architecture. Existing service tests cover
  SIP/voice coordination; do not equate them with real media/provider acceptance.
- [ ] Run required relevant checks once on integrated changes; record exact SHA,
  commands/results, native build and remaining platform/device gates.
- [ ] Opus5.5 reviews final integrated diff and evidence; fix blocker/major,
  recheck affected paths and request delta confirmation if changes invalidate it.
  Security/protocol changes, if any, require a second independent review.
- [ ] Local commits and READY_TO_SHIP only for proven scope; explicitly separate
  unimplemented native capabilities, device-only uncertainty and deployment.

## Review focus

SDK packages resolving from the workspace root; old binaries with new web code;
internal links that silently become blocked new windows; external-origin spoofing;
prebuild version resets and extension mismatch; inactive/locked call preservation.

## Opus 5.5 plan review

Reviewed by `claude-opus-5-5` (confirmed by CLI modelUsage), before implementation. Verdict: revise before proceeding. Full review is in `ios-catchup-plan-review-2026-10-26.md`.

Required amendments accepted:
- First hide Disk storage packs and buy CTA in iOS via the existing billing policy; keep usage read-only. Audit other recent monetary surfaces.
- Make the SDK check part of existing required CI `ts`, disable independent native runtime Dependabot bumps, triage mobile manifest changes for review.
- Normalize relative/uppercase-origin content links synchronously, preserve page callbacks, mailto and room confirmation; cover every activation path and prove recognized same-origin application routes never open a new window. Include chat Markdown synchronous fallback.
- Run actual WKWebView Simulator checks if local trusted HTTPS tooling permits, otherwise record unavailable, never pass Chromium off as iOS.
- Native validation: EXPO_NO_DOTENV=1; explicit test origin and identity; APS=development, incomingCalls=1, nativeCallAudio=1, then pod install and inspect lockfile. Defaults remain off.
- Add to unresolved parity boundaries: SIP incoming ringing has no APNs path; task/canvas-comment/calendar/guest events have no background phone push; background room resume after SIP still depends on WebKit microphone capture; SSO-enforced workspaces remain unavailable in this shell. These are not solved by this catch-up.
- Web readiness and native build readiness are separate; no TestFlight upload or claim of current review status. Manual QA on changed screens, no disabled visual-suite run. TS6 only if typecheck/lint pass.


## Implementation evidence before final review

Implemented: Disk purchase suppression; synchronous content links in chat, rich
editor read/modifier/bubble/phone activation and Disk preview; SDK57 alignment,
required CI SDK/iOS-export checks and Dependabot triage; validated release identity,
including a discovered stale extension bundle-ID bug on repeated prebuild.

Local checks: 178 web tests in 17 focused files; 141 mobile tests and 8 plugin tests;
mobile and desktop typecheck; changed-file renderer lint and mobile lint; frozen
lockfile install; SDK offline check; web production build; iOS Hermes export.
Metro resolves mobile React/ReactDOM 19.2.3 and TS6.0.3, independently of desktop
React19.3.1/TS5.9.3. Default Expo config has no APS/calls and rejects malformed build
identity. Workflow YAML/shell syntax checked locally; CI has not run remotely.

Native: both unsigned arm64 Release builds compiled (iPhone and Simulator),
including native incoming-call audio. Actual app/WidgetKit/NSE plists all contain
0.1.0/build21 and the same test bundle prefix. Embedded Hermes bundles contain the
explicit localhost HTTPS origin. This number is a local test identity, not an
available App Store build number. Generated Pods confirm RN0.86.3.

Manual synthetic Chromium audit inspected phone chat/DM, boards/task form,
calendar, Wiki, Canvas edit and Disk roots. A local iOS-policy fixture confirms
Disk packages/prices are absent while usage remains visible at 390/375px.
Unit tests exercise both regular usage and 413/full dialogs. No visual suite was
run; the existing iOS billing checkpoint gained Disk assertions for its future run.
Interactive WKWebView link/share-sheet/permission acceptance remains unverified:
only the Duo runtime is installed, its display capture is black/system UI and
Simulator is unavailable to the computer-use connector. The running Calab process
is not evidence that these interactions passed. Device/locked-call gates remain.

The implementation review and final disposition will be recorded separately after
reviewing the committed source. No production deployment, push or TestFlight upload.

### Additional manual acceptance and review corrections

On the rebuilt production web bundle, the 375px Wiki editor autolinked a synthetic
local CAL-3 URL. Plain tap kept editing; the phone open-link button opened CAL-3
with one browser tab and no page reload. Task and Disk usage-dialog screenshots
were inspected in dark/light themes. These are Chromium results, not WKWebView.

The independent safety review found a noncanonical configured-server edge case.
Three new tests failed for uppercase hosts/schemes and explicit default ports;
canonicalizing the configured share origin fixes the mismatch. Protocol-relative
external links retain normal external routing and now have an explicit regression.
The helper's boolean documents handoff, not OS acknowledgement. Unknown same-origin
paths are outside the known-route repair and stay blocked by the existing host.
The fixed-string CI manifest match was tightened. Native SDK security monitoring
and unsupported-link feedback are recorded in the existing technical/UI backlogs.

### Explicit unsupported links and release preparation

The known-route repair does not cover public Canvas `/c/<code>`, event RSVP
`/e/<id>/rsvp?...`, public Disk pages or arbitrary server URLs. They retain the
platform fallback; the iOS host blocks own-origin new windows, so these taps may
do nothing. Do not describe this as universal internal-link support. Tests now
record that boundary; user feedback for unsupported paths is in the UI backlog.

Distribution builds must generate iOS from a fresh checkout/generated tree with
explicit final bundle ID, identity and capability flags. Do not reuse this local
APNs-enabled tree with APS disabled: the pre-existing plugin early return retains
an old NSE target. Do not delete the owner's signed artifacts. This fresh-tree
release gate replaces an unsafe blanket recommendation to clean the working tree.
A local unsigned build with test identity is not a distribution candidate.

Current source checks use the repository-pinned Corepack pnpm 10.17.0, including
the lockfile rewrite; the deleted libc metadata is not evidence of a different
package manager. For release, also run required remote Linux CI. Visual suites
remain disabled by the newer AGENTS.md owner rule; actual manual screenshot QA
and positive unit controls are the available UI acceptance evidence here.

## Integrated verification after review corrections

`corepack pnpm -r test`: PASS, 6,224 tests passed, 18 explicitly skipped.
Breakdown: desktop 4,990; mobile 141 + 8 Node plugin tests; protocol 987; wiki-doc 24;
bot-sdk 41; landing 10; claude-bot tooling 23. No disabled visual suite was run.

The first full run found the unchanged silent TCP mail test fixture waiting for
EOF while it left handshake bytes unread. The failure reproduced using files
extracted from base e0018e108. A three-line test-only drain/comment repair resolved
it without changing timeout/closure assertions or any mail feature. The subsequent
full run above passed. Mail remains excluded from mobile implementation.

Renderer typecheck, changed-file ESLint (including the fixture), mobile types/lint,
production web build, frozen install, offline SDK check and iOS export passed.
Workflow YAML/shell syntax and isolated triage cases passed. The two previously
verified unsigned native builds remain valid: no native source changed in review.

Both initial Opus reviews and their dispositions are preserved in
[ios-catchup-implementation-review-2026-10-26.md](ios-catchup-implementation-review-2026-10-26.md).
Final delta review must name the final source commit; its local response is kept
with verification artifacts. A green local code result does not waive remote CI,
WKWebView/physical acceptance or signing/distribution gates.
