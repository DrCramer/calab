import type { MessageInitShape } from '@bufbuild/protobuf';
import type { SipScheduleSchema, SipSettings } from '@calaba/protocol';
import { create } from 'zustand';
import { t } from '../../../i18n';
import { api, uploadFile, uploadPath } from '../../../lib/api/endpoints';
import { describeError } from '../../../lib/api/errors';
import { log } from '../../../lib/log';
import { queryClient } from '../../../lib/queryClient';
import { extensionsKey, fieldError, groupsKey, menusKey, promptFileError } from '../../../lib/sipPbx';
import { reportPlanError } from '../../../services/plan';
import { toast } from '../../../stores/toasts';

/*
 * The greeting of a voice menu (ADR-0117 §6, CBF-77): one upload at a time, outside the form
 * that started it — a new menu's form becomes the menu's edit form right after «Сохранить» and a
 * list row's «Загрузить запись» opens the form, so the progress and the error survive the
 * remount. The form's prompt row subscribes to its menu's slice (whole percents: ≤ 100 renders
 * of that row, not of the form).
 */

/** Which file of a menu: the greeting, or the recording notice (ADR-0131). */
export type PromptKind = 'prompt' | 'notice';

/** The store slot of a menu's file: the menu id for the greeting, «<id>:notice» for the notice. */
export function promptSlot(menuId: string, kind: PromptKind): string {
  return kind === 'notice' ? `${menuId}:notice` : menuId;
}

interface PromptUpload {
  /** The slot (promptSlot) being uploaded to; '' = none. */
  menuId: string;
  /** Upload progress in whole percent; null while the server converts the file (or idle). */
  pct: number | null;
  /** The last refusal and its menu ('' = none). */
  errMenu: string;
  err: string;
}

export const usePromptUpload = create<PromptUpload>(() => ({ menuId: '', pct: null, errMenu: '', err: '' }));

export function promptError(menuId: string, text: string): void {
  usePromptUpload.setState({ errMenu: menuId, err: text });
}

export function clearPromptError(menuId: string): void {
  if (usePromptUpload.getState().errMenu === menuId) usePromptUpload.setState({ errMenu: '', err: '' });
}

/**
 * Checks `file` like the picker (format, ≤ 10 MB), uploads it and sets it as the menu's
 * greeting — or its recording notice (kind) — the server converts it, ≤ 60 s. A refusal stays in
 * the store under the slot; true = the file is saved.
 */
export async function uploadPrompt(workspaceId: string, menuId: string, file: File, kind: PromptKind = 'prompt'): Promise<boolean> {
  return upload(workspaceId, promptSlot(menuId, kind), file, async (id) => {
    await api.sip.updateMenu(workspaceId, menuId, kind === 'notice' ? { noticeSourceFileId: id } : { promptSourceFileId: id });
    toast.success(t(kind === 'notice' ? 'pbx.menu.noticeSaved' : 'pbx.menu.promptSaved'));
  });
}

/** The store slot of the schedule's off-hours notice (ADR-0138). */
export const SCHEDULE_NOTICE = 'schedule:notice';

/**
 * The off-hours notice of the schedule (ADR-0138 §6): uploaded like a menu's prompt and set with
 * PUT …/sip/schedule over the *saved* schedule (`saved`, the request form) — the form's unsaved
 * hours are not sent with it. The settings come back in the answer.
 */
export async function uploadScheduleNotice(workspaceId: string, file: File, saved: MessageInitShape<typeof SipScheduleSchema>, onSaved: (s: SipSettings) => void): Promise<boolean> {
  return upload(workspaceId, SCHEDULE_NOTICE, file, async (id) => {
    const r = await api.sip.saveSchedule(workspaceId, { schedule: saved, noticeSourceFileId: id });
    if (r.settings) onSaved(r.settings);
    toast.success(t('tset.sched.noticeSaved'));
  });
}

async function upload(workspaceId: string, slot: string, file: File, apply: (fileId: string) => Promise<void>): Promise<boolean> {
  const bad = promptFileError(file);
  if (bad) {
    promptError(slot, t(bad));
    return false;
  }
  if (usePromptUpload.getState().menuId) return false; // one at a time (the button is busy meanwhile)
  usePromptUpload.setState({ menuId: slot, pct: 0, errMenu: '', err: '' });
  try {
    const meta = await uploadFile(uploadPath(workspaceId, ''), file, file.name, (f) => {
      const pct = Math.min(99, Math.round(f * 100));
      const s = usePromptUpload.getState();
      if (s.menuId === slot && s.pct !== null && s.pct !== pct) usePromptUpload.setState({ pct });
    }).promise;
    usePromptUpload.setState({ pct: null });
    await apply(meta.id);
    return true;
  } catch (e) {
    log.warn('sip prompt upload', e);
    const f = fieldError(e);
    if (f) promptError(slot, f.text);
    else if (!reportPlanError(e, workspaceId)) promptError(slot, describeError(e).text);
    return false;
  } finally {
    // The row leaves «Обрабатываем запись…» once the list holds the new greeting (no flash of «Нет записи»).
    await Promise.all([extensionsKey(workspaceId), groupsKey(workspaceId), menusKey(workspaceId)].map((k) => queryClient.invalidateQueries({ queryKey: k }))).catch(() => undefined);
    usePromptUpload.setState({ menuId: '', pct: null });
  }
}
