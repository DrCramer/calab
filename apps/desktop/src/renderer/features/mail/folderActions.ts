import { isMailError, MAIL_SMART_MAX, type MailFolder, type MailSmartFolder } from '../../../shared/mail';
import { confirmAction } from '../../components/Confirm';
import { t, type MessageKey } from '../../i18n';
import { mailApi, selectBox, smartBox, updateSettings, useMail } from '../../stores/mail';
import { toast, useToasts } from '../../stores/toasts';
import { subfolderCount } from './folderTree';
import { folderLabel, mailErrorText } from './format';

/**
 * Folder operations of the sidebar and the folder dialog (CBF-56). Folders live on the IMAP server:
 * create / rename / delete wait for it (offline → a clear message, nothing queued). Smart folders
 * are local settings (`settings.smartFolders`), nothing goes to the server.
 */

type Op = 'create' | 'rename' | 'delete';

const OFFLINE: Record<Op, MessageKey> = { create: 'mbox.folders.errOffline', rename: 'mbox.folders.errOfflineRename', delete: 'mbox.folders.errOfflineDelete' };
const REFUSED: Record<Op, MessageKey> = { create: 'mbox.folders.errRefused', rename: 'mbox.folders.errRefusedRename', delete: 'mbox.folders.errRefusedDelete' };

/** The toast text of a failed folder call: offline and refused by the server get their own words. */
export function folderErrorText(op: Op, e: unknown): string {
  const code = isMailError(e) ? e.code : 'ENGINE_DOWN';
  if (code === 'NETWORK' || code === 'TIMEOUT') return t(OFFLINE[op]);
  if (code === 'INVALID') return t(REFUSED[op]);
  return mailErrorText(code);
}

/** Creates a folder on the server; resolves with it (null on failure, the toast already said why). */
export async function createFolder(accountId: string, name: string, parentId: string | null): Promise<MailFolder | null> {
  const api = mailApi();
  if (!api) return null;
  try {
    const f = await api.folders.create(accountId, name.trim(), parentId);
    toast.success(t('mbox.folders.created', { name: f.name }));
    return f;
  } catch (e) {
    toast.error(folderErrorText('create', e));
    return null;
  }
}

export async function renameFolder(folderId: string, name: string): Promise<boolean> {
  const api = mailApi();
  if (!api) return false;
  try {
    const f = await api.folders.rename(folderId, name.trim());
    toast.success(t('mbox.folders.renamed', { name: f.name }));
    // The rules followed the folder in the engine: pick up the new paths.
    const s = await api.settings.get().catch(() => null);
    if (s) useMail.setState({ settings: s });
    return true;
  } catch (e) {
    toast.error(folderErrorText('rename', e));
    return false;
  }
}

/** «Удалить…»: confirmed (irreversible, on the server), with the subfolder count when there are some. */
export async function deleteFolder(folderId: string): Promise<void> {
  const api = mailApi();
  const s = useMail.getState();
  const f = s.folderById[folderId];
  if (!api || !f) return;
  const subs = subfolderCount(s.folders[f.accountId] ?? [], folderId);
  const ok = await confirmAction(
    t('mbox.folders.deleteTitle', { name: folderLabel(f) }),
    subs ? t('mbox.folders.deleteTextSub', { n: subs }) : t('mbox.folders.deleteText'),
    t('mbox.folders.deleteConfirm'),
  );
  if (!ok) return;
  try {
    await api.folders.remove(folderId);
    toast.success(t('mbox.folders.deleted', { name: f.name }));
    const st = await api.settings.get().catch(() => null);
    if (st) useMail.setState({ settings: st });
  } catch (e) {
    toast.error(folderErrorText('delete', e));
  }
}

/** Adds or replaces a smart folder (local settings); a new one opens at once. */
export async function saveSmartFolder(f: MailSmartFolder): Promise<boolean> {
  const cur = useMail.getState().settings.smartFolders;
  const at = cur.findIndex((x) => x.id === f.id);
  if (at < 0 && cur.length >= MAIL_SMART_MAX) {
    toast.info(t('mbox.smart.max', { n: MAIL_SMART_MAX }));
    return false;
  }
  const next = at < 0 ? [...cur, f] : cur.map((x) => (x.id === f.id ? f : x));
  await updateSettings({ smartFolders: next });
  const saved = useMail.getState().settings.smartFolders.some((x) => x.id === f.id);
  if (!saved) return false;
  if (at < 0) {
    toast.success(t('mbox.smart.created', { name: f.name }));
    selectBox(smartBox(f));
  }
  return true;
}

/** Deletes a smart folder: only a view, so no confirmation — the toast offers «Отменить» (docs/08). */
export function deleteSmartFolder(id: string): void {
  const cur = useMail.getState().settings.smartFolders;
  const at = cur.findIndex((x) => x.id === id);
  const f = cur[at];
  if (!f) return;
  void updateSettings({ smartFolders: cur.filter((x) => x.id !== id) });
  useToasts.getState().push('info', t('mbox.smart.deleted', { name: f.name }), {
    label: t('mbox.rules.undo'),
    run: () => {
      const now = useMail.getState().settings.smartFolders;
      if (now.some((x) => x.id === id) || now.length >= MAIL_SMART_MAX) return;
      void updateSettings({ smartFolders: [...now.slice(0, at), f, ...now.slice(at)] });
    },
  });
}
