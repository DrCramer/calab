import type { ImportSipContactsResponse, SipContactImportSkip } from '@calaba/protocol';
import { FileUp } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Button, Modal, Spinner } from '../../../components/ui';
import { plural, t, useLocale, type MessageKey } from '../../../i18n';
import { describeError } from '../../../lib/api/errors';
import { api } from '../../../lib/api/endpoints';
import { formatPhone } from '../../../lib/sip';
import { useTelContacts } from '../../../stores/telContacts';
import { toast } from '../../../stores/toasts';
import { contactsChanged } from './data';

/**
 * «Импорт CSV» (ADR-0137 §2, §6; MANAGE_INTEGRATIONS): pick a file (on the phone — from «Файлы») →
 * the server's dry run — «Будет добавлено 120, пропущено 3» with the skipped rows and why («строка
 * 4: номер уже у «ООО Ромашка»») → «Импортировать». Rows are never merged into existing contacts.
 */

const SHOWN_SKIPS = 8;

function skipKey(reason: string): MessageKey {
  switch (reason) {
    case 'number_taken':
      return 'telc.skip.taken';
    case 'duplicate':
      return 'telc.skip.duplicate';
    case 'no_name':
      return 'telc.skip.noName';
    case 'no_number':
      return 'telc.skip.noNumber';
    case 'bad_number':
      return 'telc.skip.badNumber';
    case 'too_many_numbers':
      return 'telc.skip.tooMany';
    case 'too_long':
      return 'telc.skip.tooLong';
    case 'limit':
      return 'telc.skip.limit';
    default:
      return 'telc.skip.other';
  }
}

export function skipText(s: SipContactImportSkip): string {
  return t('telc.skip.row', { row: s.row, why: t(skipKey(s.reason), { name: s.contactName, number: s.number ? formatPhone(s.number) : '' }) });
}

export function ImportDialog({ ws }: { ws: string }): ReactNode {
  const open = useTelContacts((s) => s.importOpen);
  if (!open) return null;
  return <ImportBody ws={ws} />;
}

function ImportBody({ ws }: { ws: string }): ReactNode {
  useLocale();
  const input = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportSipContactsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const close = (): void => useTelContacts.getState().setImport(false);

  const pick = async (f: File | undefined): Promise<void> => {
    if (!f) return;
    setFile(f);
    setPreview(null);
    setError('');
    setBusy(true);
    try {
      setPreview(await api.sip.importContacts(ws, f, f.name, true));
    } catch (e) {
      setError(describeError(e).text);
    } finally {
      setBusy(false);
    }
  };
  const run = async (): Promise<void> => {
    if (!file || busy) return;
    setBusy(true);
    try {
      const r = await api.sip.importContacts(ws, file, file.name, false);
      contactsChanged(ws);
      toast.success(plural('telc.imported', r.created));
      close();
    } catch (e) {
      setError(describeError(e).text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={close}
      title={t('telc.import')}
      description={t('telc.importHint')}
      initialFocus="body"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy && !!preview} disabled={!preview || preview.created === 0} onClick={() => void run()} data-testid="telc-import-run">
            {t('telc.importRun')}
          </Button>
        </>
      }
    >
      <input ref={input} type="file" accept=".csv,text/csv,text/comma-separated-values,application/vnd.ms-excel" className="sr-only" tabIndex={-1} aria-label={t('telc.importPick')} onChange={(e) => void pick(e.target.files?.[0])} data-testid="telc-import-file" />
      <div className="flex flex-col gap-3" data-testid="telc-import">
        <Button variant="secondary" className="self-start" onClick={() => input.current?.click()} disabled={busy}>
          <FileUp className="size-4" aria-hidden />
          {file ? t('telc.importOther') : t('telc.importPick')}
        </Button>
        {file ? <p className="truncate text-caption text-muted">{file.name}</p> : null}
        {busy && !preview ? (
          <div className="flex items-center gap-2 text-body text-muted">
            <Spinner className="size-4" /> {t('telc.importChecking')}
          </div>
        ) : null}
        {error ? (
          <p className="text-body text-danger-text" role="alert">
            {error}
          </p>
        ) : null}
        {preview ? (
          <div className="rounded-[var(--radius-card)] bg-[var(--color-card)] p-3" data-testid="telc-import-preview">
            <p className="text-body font-medium text-fg">
              {t('telc.importSummary', { created: preview.created, skipped: preview.skipped.length })}
            </p>
            {preview.skipped.length ? (
              <ul className="mt-2 flex flex-col gap-1 text-caption text-muted">
                {preview.skipped.slice(0, SHOWN_SKIPS).map((s) => (
                  <li key={`${s.row}:${s.reason}:${s.number}`} className="break-words">
                    {skipText(s)}
                  </li>
                ))}
                {preview.skipped.length > SHOWN_SKIPS ? <li>{t('telc.importMore', { n: preview.skipped.length - SHOWN_SKIPS })}</li> : null}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
