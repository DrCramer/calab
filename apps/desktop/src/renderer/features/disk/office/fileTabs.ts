import { useBoardsUi } from '../../../stores/boardsUi';
import { useCanvasUi } from '../../../stores/canvasUi';
import { useDiskUi } from '../../../stores/diskUi';
import { useMailUi } from '../../../stores/mailUi';
import { useTaskTabs, type TaskTab } from '../../../stores/taskTabs';
import { useTelephonyUi } from '../../../stores/telephonyUi';
import { useUi } from '../../../stores/ui';
import { useWikiUi } from '../../../stores/wikiUi';

/**
 * Opened office files as tabs next to the task tabs (ADR-0143; stores/taskTabs.ts). One tab per
 * source (a Disk item, or a plain file); the shell shows the active one in its content slot
 * (OfficeScreen) over whatever section the file was opened from — that section is untouched, so
 * leaving the file (the editor's «Открыть расположение файла», closing the last tab) is just
 * hiding the view. The editor itself exists only while the view does.
 */
export type OfficeSource = { itemId: string } | { fileId: string };

const extLabel = (name: string): string => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).slice(0, 4).toUpperCase() : '');

export const fileTabId = (src: OfficeSource): string => ('itemId' in src ? `f:${src.itemId}` : `f:file:${src.fileId}`);

export function fileTabEntry(src: OfficeSource, name: string, ws: string): TaskTab {
  return { id: fileTabId(src), ws, board: '', key: extLabel(name), title: name, kind: 'file', ...src, at: Date.now() };
}

/** «Открыть» of an office file: its tab (an existing one is just activated) and the view. */
export function openOfficeFile(src: OfficeSource, name: string, ws = ''): void {
  const ui = useUi.getState();
  const workspace = ws || ui.activeWorkspaceId || '';
  if (workspace && ui.activeWorkspaceId !== workspace) ui.setWorkspace(workspace);
  useTaskTabs.getState().openFile(fileTabEntry(src, name, workspace));
}

/** A click on a file tab. */
export function showFileTab(id: string): void {
  const tab = useTaskTabs.getState().tabs.find((x) => x.id === id);
  if (!tab) return;
  const ui = useUi.getState();
  if (tab.ws && ui.activeWorkspaceId !== tab.ws) ui.setWorkspace(tab.ws);
  useTaskTabs.getState().showFile(id);
}

/** The cross / middle click: a clean tab goes at once, one with unsaved changes asks (save and close, discard, cancel). */
export function closeFileTab(id: string): void {
  const st = useTaskTabs.getState();
  if (st.fileMounted === id && st.fileMark[id]) {
    useUi.getState().openDialog({ kind: 'office-unsaved', tabId: id });
    return;
  }
  st.removeFile(id);
}

/** The answer of the unsaved-changes dialog. */
export function resolveUnsaved(id: string, answer: 'save' | 'discard' | 'cancel'): void {
  const st = useTaskTabs.getState();
  if (answer === 'discard') st.removeFile(id);
  else if (answer === 'save') st.setFileClosing(id);
}

/**
 * Any other navigation leaves the file view: a workspace switch, a section turned on, a day or a
 * room opened. (The tab strip and the editor's own «back» call leaveFile directly.) Installed once
 * by the shell; the subscriptions fire only on a real change.
 */
export function installFileViewLeave(): () => void {
  const leave = (): void => useTaskTabs.getState().leaveFile();
  const offs = [
    useUi.subscribe((s, p) => {
      if (s.activeWorkspaceId !== p.activeWorkspaceId || (s.calDay !== null && s.calDay !== p.calDay) || s.lastRoom !== p.lastRoom) leave();
    }),
    useBoardsUi.subscribe((s, p) => s.active && !p.active && leave()),
    useDiskUi.subscribe((s, p) => s.active && !p.active && leave()),
    useWikiUi.subscribe((s, p) => s.active && !p.active && leave()),
    useCanvasUi.subscribe((s, p) => s.active && !p.active && leave()),
    useTelephonyUi.subscribe((s, p) => s.active && !p.active && leave()),
    useMailUi.subscribe((s, p) => s.active && !p.active && leave()),
  ];
  return () => offs.forEach((off) => off());
}
