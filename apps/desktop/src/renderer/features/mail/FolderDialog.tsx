import { Plus, X } from 'lucide-react';
import { useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { MAIL_SMART_CONDITIONS_MAX, type MailCondition, type MailFolder, type MailSmartFolder } from '../../../shared/mail';
import { Button, Field, IconButton, Input, Modal, Segmented, Select, Switch } from '../../components/ui';
import { t } from '../../i18n';
import { useMail } from '../../stores/mail';
import { useMailUi, type FolderDialogReq } from '../../stores/mailUi';
import { createFolder, renameFolder, saveSmartFolder } from './folderActions';
import { folderLabel, folderNameIssue } from './format';

/**
 * The folder dialog (CBF-56, Apple Mail «New Mailbox» / «Smart Mailbox»): a new folder in an
 * account (on the IMAP server) or, with «Умная папка», a smart folder (local rules over the synced
 * mail, never an IMAP folder); renaming an own folder; editing a smart folder.
 */
export function FolderDialog(): ReactNode {
  const req = useMailUi((s) => s.folderDialog);
  if (!req) return null;
  return <FolderDialogBody key={JSON.stringify(req)} req={req} />;
}

const close = (): void => useMailUi.getState().openFolderDialog(null);

/** Why a name cannot be used (before the engine's own check): characters, or a sibling of that name. */
function nameIssue(name: string, siblings: readonly MailFolder[], self: string | null): 'name' | 'exists' | null {
  const chars = folderNameIssue(name, []);
  if (chars) return chars;
  const low = name.trim().toLowerCase();
  return low && siblings.some((f) => f.id !== self && f.path !== '' && f.name.toLowerCase() === low) ? 'exists' : null;
}

const blankCondition = (): MailCondition => ({ field: 'from', contains: '' });

function FolderDialogBody({ req }: { req: FolderDialogReq }): ReactNode {
  const folders = useMail((s) => s.folders);
  const accounts = useMail((s) => s.accounts);
  const accountIds = useMail((s) => s.accountIds);
  const smartList = useMail((s) => s.settings.smartFolders);
  const editingSmart = req.kind === 'smart' ? (smartList.find((x) => x.id === req.smartId) ?? null) : null;
  const renaming = req.kind === 'rename' ? (Object.values(folders).flat().find((f) => f.id === req.folderId) ?? null) : null;
  const accountId = req.kind === 'create' ? req.accountId : (renaming?.accountId ?? editingSmart?.accountId ?? null);
  const parent = req.kind === 'create' && req.parentId ? (folders[req.accountId ?? '']?.find((f) => f.id === req.parentId) ?? null) : null;

  const [name, setName] = useState(renaming?.name ?? editingSmart?.name ?? '');
  const [smart, setSmart] = useState(req.kind === 'smart' || (req.kind === 'create' && req.smart));
  const [scope, setScope] = useState<string>(editingSmart ? (editingSmart.accountId ?? '') : (accountId ?? ''));
  const [match, setMatch] = useState<MailSmartFolder['match']>(editingSmart?.match ?? 'all');
  const [conds, setConds] = useState<MailCondition[]>(editingSmart?.conditions.length ? editingSmart.conditions : [blankCondition()]);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const formId = useId();

  const siblings = (accountId ? folders[accountId] : undefined)?.filter((f) => f.parentId === (renaming ? renaming.parentId : (parent?.id ?? null))) ?? [];
  const issue = smart ? null : nameIssue(name, siblings, renaming?.id ?? null);
  const usable = conds.filter((c) => c.contains.trim());
  const valid = !!name.trim() && !issue && (!smart || usable.length > 0) && (smart || !!accountId);
  const email = accountId ? (accounts[accountId]?.email ?? '') : '';

  const title =
    req.kind === 'rename'
      ? t('mbox.folders.renameTitle')
      : req.kind === 'smart'
        ? t('mbox.smart.titleEdit')
        : smart
          ? t('mbox.smart.titleNew')
          : t('mbox.folders.new');
  const description =
    req.kind === 'rename' || smart ? undefined : parent ? t('mbox.folders.whereIn', { folder: folderLabel(parent), email }) : email ? t('mbox.folders.where', { email }) : undefined;

  const submit = async (e?: SyntheticEvent): Promise<void> => {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    let ok = false;
    if (smart) {
      const f: MailSmartFolder = {
        id: editingSmart?.id ?? crypto.randomUUID(),
        name: name.trim(),
        accountId: scope || null,
        match,
        conditions: usable.map((c) => ({ field: c.field, contains: c.contains.trim() })),
      };
      ok = await saveSmartFolder(f);
    } else if (renaming) {
      ok = renaming.name === name.trim() || (await renameFolder(renaming.id, name));
    } else if (accountId) {
      ok = (await createFolder(accountId, name, parent?.id ?? null)) !== null;
    }
    if (ok) close();
    else setBusy(false);
  };

  const setCond = (i: number, patch: Partial<MailCondition>): void => setConds((l) => l.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <Modal
      open
      onClose={close}
      title={title}
      description={description}
      medium={smart}
      initialFocus={nameRef}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} busy={busy} disabled={!valid} data-testid="mail-folder-dialog-submit">
            {req.kind === 'create' ? t('mbox.folders.create') : t('mbox.folders.save')}
          </Button>
        </>
      }
    >
      <form id={formId} className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} data-testid="mail-folder-dialog">
        <Field label={t('mbox.folders.name')} error={issue ? t(issue === 'exists' ? 'mbox.folders.errExists' : 'mbox.folders.errName') : null} hint={smart ? undefined : req.kind === 'create' ? t('mbox.folders.newHint') : undefined}>
          <Input ref={nameRef} value={name} maxLength={100} placeholder={t('mbox.folders.namePlaceholder')} aria-invalid={issue ? true : undefined} onChange={(e) => setName(e.target.value)} data-testid="mail-folder-name" />
        </Field>
        {req.kind === 'create' && !parent ? <Switch checked={smart} onChange={setSmart} label={t('mbox.smart.toggle')} hint={t('mbox.smart.toggleHint')} /> : null}
        {smart ? (
          <>
            {accountIds.length > 1 || (editingSmart && editingSmart.accountId === null) ? (
              <Field label={t('mbox.smart.scope')}>
                <Select value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="">{t('mbox.smart.scopeAll')}</option>
                  {accountIds.map((id) => (
                    <option key={id} value={id}>
                      {accounts[id]?.email ?? id}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                <span className="text-caption font-medium text-muted">{t('mbox.smart.match')}</span>
                <Segmented
                  value={match}
                  onChange={setMatch}
                  label={t('mbox.smart.match')}
                  options={[
                    { value: 'all', label: t('mbox.smart.matchAll') },
                    { value: 'any', label: t('mbox.smart.matchAny') },
                  ]}
                />
              </div>
              <ul className="flex flex-col gap-2" data-testid="mail-smart-conditions">
                {conds.map((c, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2">
                    <Select value={c.field} onChange={(e) => setCond(i, { field: e.target.value === 'subject' ? 'subject' : e.target.value === 'to' ? 'to' : 'from' })} aria-label={t('mbox.rules.field')} className="w-48 shrink-0">
                      <option value="from">{t('mbox.smart.field.from')}</option>
                      <option value="to">{t('mbox.smart.field.to')}</option>
                      <option value="subject">{t('mbox.smart.field.subject')}</option>
                    </Select>
                    <Input
                      value={c.contains}
                      maxLength={200}
                      aria-label={t('mbox.rules.text')}
                      placeholder={t(c.field === 'subject' ? 'mbox.rules.subjectPlaceholder' : 'mbox.rules.textPlaceholder')}
                      className="min-w-[10rem] flex-1"
                      onChange={(e) => setCond(i, { contains: e.target.value })}
                    />
                    <IconButton label={t('mbox.smart.removeCondition')} size="sm" disabled={conds.length === 1} onClick={() => setConds((l) => l.filter((_, j) => j !== i))}>
                      <X className="size-3.5" />
                    </IconButton>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button size="sm" variant="ghost" disabled={conds.length >= MAIL_SMART_CONDITIONS_MAX} onClick={() => setConds((l) => [...l, blankCondition()])} data-testid="mail-smart-add-condition">
                  <Plus className="size-3.5" aria-hidden />
                  {t('mbox.smart.addCondition')}
                </Button>
              </div>
              <p className="text-caption text-faint">{t('mbox.smart.hint')}</p>
            </div>
          </>
        ) : null}
      </form>
    </Modal>
  );
}
