import { lazyPreload } from '../../lib/lazyPreload';

// Windows that are not needed to show the chat, in their own chunks (docs/18 step 9): app and
// workspace settings, the superadmin window and the first-run onboarding. Preloaded on idle after
// READY (AppShell) and on hover of the settings button, so opening them is instant.

export const AppSettingsWindow = lazyPreload(() => import('../settings/AppSettingsDialog').then((m) => m.AppSettingsDialog));
export const WorkspaceSettingsWindow = lazyPreload(() => import('../workspace/WorkspaceSettings').then((m) => m.WorkspaceSettingsDialog));
export const AdminWindowLazy = lazyPreload(() => import('../admin/AdminWindow').then((m) => m.AdminWindow));
// Fallback: the onboarding's own backdrop (mat-content, draggable), for the few ms of a cold load.
export const OnboardingLazy = lazyPreload(
  () => import('../onboarding/Onboarding').then((m) => m.Onboarding),
  <div className="mat-content drag h-full" />,
);

// The office file view (ADR-0143): its chunk loads on the first «Открыть» of an office file.
export const OfficeScreenLazy = lazyPreload(() => import('../disk/office/OfficeScreen').then((m) => m.OfficeScreen));

/** After READY, when idle: the settings windows (and the admin one for a superadmin). */
export function preloadWindows(superadmin: boolean): void {
  void AppSettingsWindow.preload();
  void WorkspaceSettingsWindow.preload();
  if (superadmin) void AdminWindowLazy.preload();
}
