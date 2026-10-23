import { TriangleAlert } from 'lucide-react';
import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { isMailError, MAIL_RULES_MAX, type MailAccount, type MailCertInfo, type MailRule } from '../../../shared/mail';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, Field, Input, Modal, PasswordInput, Row, Segmented, Select, TextArea, Toggle } from '../../components/ui';
import { plural, t } from '../../i18n';
import { fmt } from '../../lib/format';
import { mailApi, setGrouping, updateSettings, useMail } from '../../stores/mail';
import { useMailUi } from '../../stores/mailUi';
import { toast, useToasts } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { accountCertIssues, CertNotice, certTitle, pinTail, unpin } from '../mail/CertNotice';
import { platform } from '../../platform';
import { APP_PASSWORD_URL, folderLabel, folderNameIssue, mailErrorText } from '../mail/format';
import { openSection } from '../shell/sectionNav';
import { CommitInput } from './CommitInput';

const GB = 1024 * 1024 * 1024;
const CACHE_LIMITS = [256 * 1024 * 1024, 512 * 1024 * 1024, GB, 2 * GB, 5 * GB, 10 * GB];

const errText = (e: unknown): string => mailErrorText(isMailError(e) ? e.code : 'ENGINE_DOWN');

/**
 * Settings → «Почта» (ADR-0088 §8; desktop only): the accounts (add, remove, password, sender
 * name, signature), new-mail notifications, remote images, the body cache size.
 */
export function MailTab(): ReactNode {
  const ids = useMail((s) => s.accountIds);
  const notify = useMail((s) => s.settings.notify);
  const group = useMail((s) => s.settings.groupThreads);
  const images = useMail((s) => s.settings.remoteImages);
  const cache = useMail((s) => s.settings.cacheLimitBytes);
  const addAccount = (): void => {
    useUi.getState().openDialog(null);
    openSection('mail');
    useMailUi.getState().openAdd();
  };
  return (
    <>
      <Card title={t('mbox.settings.accounts')} footer={t('mbox.settings.accountsHint')}>
        {ids.length ? ids.map((id) => <AccountRows key={id} id={id} />) : <Row label={t('mbox.settings.noAccounts')} />}
        <Row label={t('mbox.addAccount')}>
          <Button size="sm" variant="secondary" onClick={addAccount} data-testid="settings-mail-add">
            {t('mbox.add.submit')}
          </Button>
        </Row>
      </Card>
      <Card title={t('mbox.settings.reading')}>
        <Row label={t('mbox.settings.notify')} hint={t('mbox.settings.notifyHint')}>
          <Toggle checked={notify} onChange={(v) => void updateSettings({ notify: v })} label={t('mbox.settings.notify')} />
        </Row>
        <Row label={t('mbox.settings.group')} hint={t('mbox.settings.groupHint')}>
          <Toggle checked={group} onChange={(v) => void setGrouping(v)} label={t('mbox.settings.group')} />
        </Row>
        <Row label={t('mbox.settings.images')} hint={t('mbox.settings.imagesHint')}>
          <Segmented
            value={images}
            onChange={(v) => void updateSettings({ remoteImages: v })}
            label={t('mbox.settings.images')}
            options={[
              { value: 'ask', label: t('mbox.settings.imagesAsk') },
              { value: 'always', label: t('mbox.settings.imagesAlways') },
            ]}
          />
        </Row>
        <SendersRow />
      </Card>
      <Card title={t('mbox.settings.cache')} footer={t('mbox.settings.cacheHint')}>
        <Row label={t('mbox.settings.cacheLimit')}>
          <Select value={cache} onChange={(e) => void updateSettings({ cacheLimitBytes: Number(e.target.value) })} aria-label={t('mbox.settings.cacheLimit')} className="w-36">
            {[...new Set([...CACHE_LIMITS, cache])]
              .sort((a, b) => a - b)
              .map((v) => (
                <option key={v} value={v}>
                  {fmt.size(v)}
                </option>
              ))}
          </Select>
        </Row>
        <Row label={t('mbox.settings.clearCache')} hint={t('mbox.settings.clearCacheHint')}>
          <ClearCacheButton />
        </Row>
      </Card>
    </>
  );
}

/** «Очистить»: drops cached bodies and attachments of every account (headers, drafts, outbox stay). */
function ClearCacheButton(): ReactNode {
  const [busy, setBusy] = useState(false);
  const clear = async (): Promise<void> => {
    const api = mailApi();
    if (!api || busy) return;
    setBusy(true);
    try {
      await api.settings.clearCache();
      toast.success(t('mbox.settings.cacheCleared'));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="secondary" busy={busy} onClick={() => void clear()} data-testid="settings-mail-clear-cache">
      {t('mbox.settings.clear')}
    </Button>
  );
}

/** «Всегда для этого отправителя»: the list, each removable. */
function SendersRow(): ReactNode {
  const senders = useMail((s) => s.settings.remoteImageSenders);
  if (!senders.length) return null;
  return (
    <Row label={t('mbox.settings.senders')} hint={senders.join(', ')}>
      <Button size="sm" variant="ghost" onClick={() => void updateSettings({ remoteImageSenders: [] })}>
        {t('mbox.settings.clear')}
      </Button>
    </Row>
  );
}

function stateText(a: MailAccount): string | null {
  if (a.state === 'auth_failed') return t('mbox.state.authFailed');
  if (a.state === 'offline') return t('mbox.state.offline');
  if (a.state === 'error') return a.error ? mailErrorText(a.error.code) : t('mbox.state.error');
  if (a.state === 'syncing') return t('mbox.state.syncing');
  return null;
}

function AccountRows({ id }: { id: string }): ReactNode {
  const account = useMail((s) => s.accounts[id]);
  const signature = useMail((s) => s.settings.signatures[id] ?? '');
  const [password, setPassword] = useState(false);
  const [certOpen, setCertOpen] = useState<{ kind: 'imap' | 'smtp'; cert: MailCertInfo } | null>(null);
  if (!account) return null;
  const api = mailApi();
  const state = stateText(account);
  const remove = async (): Promise<void> => {
    if (!api) return;
    const ok = await confirmAction(t('mbox.settings.removeTitle', { email: account.email }), t('mbox.settings.removeText'), t('mbox.settings.remove'));
    if (!ok) return;
    try {
      await api.accounts.remove(id);
      toast.success(t('mbox.settings.removed'));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  return (
    <div data-testid="settings-mail-account">
      <Row label={account.email} hint={state ?? `${account.imap.host} · ${account.smtp.host}`}>
        {account.state === 'auth_failed' ? <TriangleAlert className="size-4 text-warn" aria-hidden /> : null}
        <Button size="sm" variant={account.state === 'auth_failed' ? 'primary' : 'secondary'} onClick={() => setPassword(true)}>
          {t('mbox.settings.password')}
        </Button>
        <Button size="sm" variant="destructive" onClick={() => void remove()}>
          {t('mbox.settings.remove')}
        </Button>
      </Row>
      <CertRows account={account} onShow={setCertOpen} />
      <Row label={t('mbox.settings.name')} hint={t('mbox.settings.nameHint')}>
        <CommitInput
          value={account.name}
          label={t('mbox.settings.name')}
          maxLength={120}
          onCommit={async (name) => {
            if (!api) return;
            await api.accounts.update(id, { name });
          }}
        />
      </Row>
      <StackRow label={t('mbox.settings.signature')}>
        <SignatureField id={id} value={signature} />
      </StackRow>
      <FolderRows id={id} />
      {password ? <PasswordDialog account={account} onClose={() => setPassword(false)} /> : null}
      {certOpen ? <CertDialog account={account} kind={certOpen.kind} cert={certOpen.cert} onClose={() => setCertOpen(null)} /> : null}
    </div>
  );
}

/**
 * Certificates of an account (ADR-0088 §4): «Сертификат: закреплён ⋯ab12 · Сбросить» per pinned
 * server, and a certificate that stopped the sync / the last send («Сертификат сервера изменился»
 * · «Показать и доверять новому»): the account stays in `error` until it is accepted.
 */
function CertRows({ account, onShow }: { account: MailAccount; onShow: (v: { kind: 'imap' | 'smtp'; cert: MailCertInfo }) => void }): ReactNode {
  const issues = accountCertIssues(account);
  const reset = async (kind: 'imap' | 'smtp'): Promise<void> => {
    const api = mailApi();
    if (!api) return;
    try {
      await api.accounts.update(account.id, { [kind]: unpin(account[kind]) });
      toast.success(t('mbox.cert.resetDone'));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const [now] = useState(() => Date.now());
  return (
    <>
      {issues.map((i) => (
        <Row key={`issue-${i.kind}`} label={i.cert.reason === 'changed' ? t('mbox.cert.changed') : certTitle(i.cert, now)} hint={`${i.cert.host}:${String(i.cert.port)}`}>
          <TriangleAlert className="size-4 text-warn" aria-hidden />
          <Button size="sm" variant="primary" onClick={() => onShow(i)} data-testid="settings-mail-cert-show">
            {i.cert.reason === 'changed' ? t('mbox.cert.showTrust') : t('mbox.cert.show')}
          </Button>
        </Row>
      ))}
      {(['imap', 'smtp'] as const).map((kind) => {
        const pin = account[kind].pinnedCert;
        if (!pin) return null;
        return (
          <Row key={`pin-${kind}`} label={t('mbox.cert.pinned', { fp: pinTail(pin) })} hint={`${account[kind].host}:${String(account[kind].port)}`}>
            <Button size="sm" variant="ghost" onClick={() => void reset(kind)} data-testid="settings-mail-cert-reset">
              {t('mbox.cert.reset')}
            </Button>
          </Row>
        );
      })}
    </>
  );
}

/** The trust prompt for an existing account: pins the shown certificate (no new login, §4). */
function CertDialog({ account, kind, cert, onClose }: { account: MailAccount; kind: 'imap' | 'smtp'; cert: MailCertInfo; onClose: () => void }): ReactNode {
  const [busy, setBusy] = useState(false);
  const trust = async (): Promise<void> => {
    const api = mailApi();
    if (!api || busy) return;
    setBusy(true);
    try {
      await api.accounts.update(account.id, { [kind]: { ...unpin(account[kind]), pinnedCert: cert.fingerprint256 } });
      toast.success(t('mbox.cert.trusted'));
      onClose();
    } catch (e) {
      setBusy(false);
      toast.error(errText(e));
    }
  };
  return (
    <Modal open onClose={onClose} title={t('mbox.cert.dialog', { server: `${cert.host}:${String(cert.port)}` })}>
      <CertNotice cert={cert} busy={busy} onTrust={() => void trust()} />
    </Modal>
  );
}

/** Own folders and sorting rules of one account (CBF-39); rules live in the mail settings. */
function FolderRows({ id }: { id: string }): ReactNode {
  const folders = useMail((s) => s.folders[id]);
  const allRules = useMail((s) => s.settings.rules);
  const rules = useMemo(() => allRules.filter((r) => r.accountId === id), [allRules, id]);
  // Rule targets: the user's own folders first (the likely choice, and the default), then archive / sent / junk / trash.
  const targets = useMemo(() => {
    const real = (folders ?? []).filter((f) => f.path !== '' && f.role !== 'inbox' && f.role !== 'drafts' && f.role !== 'starred');
    return [...real.filter((f) => !f.role).sort((a, b) => a.path.localeCompare(b.path)), ...real.filter((f) => f.role)];
  }, [folders]);
  const nameId = useId();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [field, setField] = useState<MailRule['field']>('from');
  const [text, setText] = useState('');
  const [dest, setDest] = useState('');
  const destPath = targets.some((f) => f.path === dest) ? dest : (targets[0]?.path ?? '');
  const issue = folderNameIssue(name, folders ?? []);
  const full = allRules.length >= MAIL_RULES_MAX;
  const create = async (): Promise<void> => {
    const api = mailApi();
    const clean = name.trim();
    if (!api || creating || !clean || issue) return;
    setCreating(true);
    try {
      const f = await api.folders.create(id, clean);
      setName('');
      // The rule form below offers the new folder at once.
      setDest(f.path);
      toast.success(t('mbox.folders.created', { name: f.name }));
    } catch (e) {
      const code = isMailError(e) ? e.code : null;
      toast.error(code === 'INVALID' ? t('mbox.folders.errRefused') : code === 'NETWORK' || code === 'TIMEOUT' ? t('mbox.folders.errOffline') : errText(e));
    } finally {
      setCreating(false);
    }
  };
  const addRule = (): void => {
    const contains = text.trim();
    if (!contains || !destPath || full) return;
    if (rules.some((r) => r.field === field && r.folderPath === destPath && r.contains.toLowerCase() === contains.toLowerCase())) {
      toast.info(t('mbox.rules.duplicate'));
      return;
    }
    const rule: MailRule = { id: crypto.randomUUID(), accountId: id, field, contains, folderPath: destPath };
    void updateSettings({ rules: [...allRules, rule] });
    setText('');
  };
  // No confirmation (docs/08: only for the irreversible) — the toast offers «Отменить» instead.
  const removeRule = (rule: MailRule): void => {
    const at = allRules.findIndex((x) => x.id === rule.id);
    void updateSettings({ rules: allRules.filter((x) => x.id !== rule.id) });
    useToasts.getState().push('info', t('mbox.rules.removed'), {
      label: t('mbox.rules.undo'),
      run: () => {
        const cur = useMail.getState().settings.rules;
        if (cur.some((x) => x.id === rule.id) || cur.length >= MAIL_RULES_MAX) return;
        void updateSettings({ rules: [...cur.slice(0, at), rule, ...cur.slice(at)] });
      },
    });
  };
  const apply = async (): Promise<void> => {
    const api = mailApi();
    if (!api || applying) return;
    setApplying(true);
    try {
      const r = await api.folders.applyRules(id);
      if (r.moved) toast.success(plural('mbox.folders.applied', r.moved));
      else toast.info(t('mbox.rules.appliedNone'));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setApplying(false);
    }
  };
  const ruleHint = (path: string): ReactNode => {
    const f = folders?.find((x) => x.path === path);
    // A folder gone on the server (or renamed elsewhere): the rule stays but files nothing.
    if (folders && !f) return <span className="text-danger-text">{t('mbox.rules.missing', { folder: path })}</span>;
    return t('mbox.rules.to', { folder: f ? folderLabel(f) : path });
  };
  const ruleLabel = (r: MailRule, i: number): string => {
    const s = t(r.field === 'from' ? 'mbox.rules.fromRow' : 'mbox.rules.subjectRow', { text: r.contains });
    // Numbered when there are several: the first match wins, so the order matters.
    return rules.length > 1 ? `${String(i + 1)}. ${s}` : s;
  };
  const enter = (e: KeyboardEvent<HTMLInputElement>, run: () => void): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) run();
  };
  return (
    <>
      <StackRow label={t('mbox.folders.new')} htmlFor={nameId} hint={issue ? <span className="text-danger-text" role="alert">{t(issue === 'exists' ? 'mbox.folders.errExists' : 'mbox.folders.errName')}</span> : t('mbox.folders.newHint')}>
        <Input id={nameId} value={name} maxLength={100} placeholder={t('mbox.folders.namePlaceholder')} className="min-w-[12rem] flex-1" aria-invalid={issue ? true : undefined} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => enter(e, () => void create())} />
        <Button size="sm" variant="secondary" busy={creating} disabled={!name.trim() || !!issue} onClick={() => void create()} data-testid="settings-mail-folder-create">
          {t('mbox.folders.create')}
        </Button>
      </StackRow>
      {rules.map((r, i) => {
        const label = ruleLabel(r, i);
        return (
          <Row key={r.id} label={label} hint={ruleHint(r.folderPath)}>
            <Button size="sm" variant="ghost" aria-label={t('mbox.rules.removeLabel', { rule: label })} onClick={() => removeRule(r)} data-testid="settings-mail-rule-remove">
              {t('mbox.settings.remove')}
            </Button>
          </Row>
        );
      })}
      <StackRow label={t('mbox.rules.add')} hint={full ? t('mbox.rules.max', { n: MAIL_RULES_MAX }) : targets.length ? t('mbox.rules.addHint') : t('mbox.rules.noFolders')}>
        <Select value={field} onChange={(e) => setField(e.target.value === 'subject' ? 'subject' : 'from')} aria-label={t('mbox.rules.field')} className="w-36 shrink-0">
          <option value="from">{t('mbox.rules.from')}</option>
          <option value="subject">{t('mbox.rules.subject')}</option>
        </Select>
        <Input value={text} maxLength={200} aria-label={t('mbox.rules.text')} placeholder={t(field === 'from' ? 'mbox.rules.textPlaceholder' : 'mbox.rules.subjectPlaceholder')} className="min-w-[10rem] flex-[2_1_12rem]" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => enter(e, addRule)} />
        <Select value={destPath} onChange={(e) => setDest(e.target.value)} aria-label={t('mbox.rules.folder')} className="min-w-[9rem] flex-[1_1_9rem]" disabled={!targets.length}>
          {targets.map((f) => (
            <option key={f.id} value={f.path}>
              {folderLabel(f)}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="secondary" disabled={!text.trim() || !destPath || full} onClick={addRule} data-testid="settings-mail-rule-add">
          {t('mbox.rules.addButton')}
        </Button>
      </StackRow>
      {rules.length ? (
        <Row label={t('mbox.rules.apply')} hint={t('mbox.rules.applyHint')}>
          <Button size="sm" variant="secondary" busy={applying} onClick={() => void apply()} data-testid="settings-mail-rules-apply">
            {t('mbox.rules.applyButton')}
          </Button>
        </Row>
      ) : null}
    </>
  );
}

/**
 * A settings row whose controls need the width (CBF-56: the rule form, the new folder, the
 * signature): the title on its own line, the controls under it wrapping onto more lines when the
 * window is narrow, the hint under the controls — never squeezed into a narrow label column.
 */
function StackRow({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }): ReactNode {
  const searchHint = typeof hint === 'string' ? hint : undefined;
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5" data-settings-row data-testid="settings-stack-row">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-body" data-settings-label data-settings-hint={searchHint}>
          {label}
        </label>
      ) : (
        <span className="text-body" data-settings-label data-settings-hint={searchHint}>
          {label}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {hint ? <span className="text-caption text-faint">{hint}</span> : null}
    </div>
  );
}

/** The plain-text signature (§8), saved on blur. */
function SignatureField({ id, value }: { id: string; value: string }): ReactNode {
  const [v, setV] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setV(value);
  }
  return (
    <TextArea
      value={v}
      rows={3}
      maxLength={2000}
      aria-label={t('mbox.settings.signature')}
      placeholder={t('mbox.settings.signaturePlaceholder')}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v === value) return;
        void updateSettings({ signatures: { ...useMail.getState().settings.signatures, [id]: v } });
      }}
      className="w-full py-1"
    />
  );
}

/** «Сменить пароль» (and the answer to `auth_failed`): checked by logging in, then stored by main (§3). */
function PasswordDialog({ account, onClose }: { account: MailAccount; onClose: () => void }): ReactNode {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    const api = mailApi();
    if (!api || !value || busy) return;
    setBusy(true);
    setHelp(null);
    try {
      await api.accounts.setPassword(account.id, value);
      toast.success(t('mbox.settings.passwordSaved'));
      onClose();
    } catch (e) {
      setBusy(false);
      setError(errText(e));
      // Same hint as the add form: a wrong password at a provider with app passwords.
      setHelp(isMailError(e) && e.code === 'AUTH_FAILED' ? (APP_PASSWORD_URL[account.provider] ?? null) : null);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('mbox.settings.passwordTitle', { email: account.email })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} busy={busy} disabled={!value}>
            {t('mbox.settings.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={t('mbox.add.password')} error={error}>
          <PasswordInput autoFocus autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        {help ? (
          <p className="pt-2 text-caption text-muted" data-testid="mail-password-help">
            {t('mbox.add.needAppPassword')}{' '}
            <button type="button" className="text-accent-text underline" onClick={() => void platform.app.openExternal(help)}>
              {t('mbox.add.appPasswordHow')}
            </button>
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
