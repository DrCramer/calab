import { create } from '@bufbuild/protobuf';
import {
  BoardFormAnswerSchema,
  BoardFormFieldType as Kind,
  type BoardFormAnswer,
  type BoardFormField,
  type BoardFormPeopleOptions,
  type BoardFormPerson,
} from '@calaba/protocol';
import { Paperclip, X } from 'lucide-react';
import { memo, useCallback, useRef, useState, type ReactNode } from 'react';
import { Button, Input, Select } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';

export const formControl = 'w-full rounded-[var(--radius-control)] border border-line bg-elev px-3 py-2 text-body text-fg';
export function formError(e: unknown): string {
  return e instanceof ApiError && e.reason === 'FORM_CHANGED' ? t('forms.changed') : t('forms.error');
}

/** Uploads one file of a FILE field; resolves to the upload id (ADR-0064 v2). */
export type FormUpload = (fieldId: string, file: File, onProgress: (fraction: number) => void) => { promise: Promise<string>; abort(): void };

const ACCEPT: Record<string, string> = {
  image: 'image/*',
  pdf: '.pdf,application/pdf',
  document: '.txt,.csv,.rtf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp',
  video: 'video/*',
  audio: 'audio/*',
  archive: '.zip,.gz,.rar,.7z,.tar',
};

const maxFiles = (f: BoardFormField): number => (!f.multiple ? 1 : f.maxFiles || 5);

export function FormFields({
  fields,
  submit,
  preview = false,
  people,
  upload,
}: {
  fields: BoardFormField[];
  submit: (answers: BoardFormAnswer[]) => Promise<unknown>;
  preview?: boolean;
  /** Candidates of the PEOPLE fields (names only). */
  people?: BoardFormPeopleOptions[];
  /** Stages files; without it (preview) a file answer is its name. */
  upload?: FormUpload;
}): ReactNode {
  const [values, setValues] = useState<Record<string, string>>({});
  const [multiValues, setMultiValues] = useState<Record<string, string[]>>({});
  const [uploading, setUploading] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [bad, setBad] = useState('');
  const setList = useCallback((id: string, list: string[]) => setMultiValues((old) => ({ ...old, [id]: list })), []);
  const setPending = useCallback((id: string, n: number) => setUploading((old) => ({ ...old, [id]: n })), []);
  if (done)
    return (
      <div role="status" className="py-8 text-center text-headline">
        {t(preview ? 'forms.previewSuccess' : 'forms.success')}
      </div>
    );
  const list = (f: BoardFormField): boolean => f.type === Kind.MULTISELECT || f.type === Kind.FILE || f.type === Kind.PEOPLE;
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        const waiting = fields.find((f) => (uploading[f.id] ?? 0) > 0);
        if (waiting) {
          setBad(waiting.id);
          setError(t('forms.waitUploads'));
          return;
        }
        const missing = fields.find((f) => list(f) && f.required && !multiValues[f.id]?.length);
        if (missing) {
          setBad(missing.id);
          setError(t(missing.type === Kind.MULTISELECT ? 'forms.chooseAtLeastOne' : missing.type === Kind.FILE ? 'forms.attachRequired' : 'forms.choosePerson'));
          return;
        }
        setBusy(true);
        setError('');
        setBad('');
        void submit(
          fields.map((f) =>
            create(BoardFormAnswerSchema, {
              fieldId: f.id,
              value: list(f) ? '' : (values[f.id] ?? (f.type === Kind.CHECKBOX ? 'false' : '')),
              values: list(f) ? (multiValues[f.id] ?? []) : [],
            }),
          ),
        )
          .then(() => setDone(true))
          .catch((err: unknown) => {
            const invalid = err instanceof ApiError && err.status === 422 ? fields.find((f) => f.id === err.field) : undefined;
            setError(
              invalid?.type === Kind.PHONE ? t('forms.invalidPhone') : invalid?.type === Kind.URL ? t('forms.invalidUrl') : formError(err),
            );
            if (err instanceof ApiError) setBad(err.field ?? '');
          })
          .finally(() => setBusy(false));
      }}
    >
      {preview ? <p className="rounded-[var(--radius-card)] bg-hover p-3 text-caption text-muted">{t('forms.previewHint')}</p> : null}
      {fields.map((f) => {
        const id = `form-field-${f.id}`;
        const value = values[f.id] ?? '';
        const update = (v: string): void => setValues((old) => ({ ...old, [f.id]: v }));
        const props = {
          id,
          required: f.required,
          'aria-invalid': bad === f.id,
          'aria-describedby': `${id}-hint`,
          disabled: busy,
        };
        const grouped = f.type === Kind.MULTISELECT || f.type === Kind.FILE || (f.type === Kind.PEOPLE && f.multiple);
        return (
          <div key={f.id} className="flex flex-col gap-1.5">
            <label id={`${id}-label`} htmlFor={grouped ? undefined : id} className="text-body font-medium">
              {f.label}
              {f.required ? ' *' : ''}
            </label>
            {f.type === Kind.PARAGRAPH ? (
              <textarea
                {...props}
                className={`${formControl} !rounded-[var(--radius-card)]`}
                rows={4}
                maxLength={2000}
                placeholder={f.placeholder}
                value={value}
                onChange={(e) => update(e.target.value)}
              />
            ) : f.type === Kind.SELECT ? (
              <Select {...props} value={value} onChange={(e) => update(e.target.value)}>
                <option value="">{f.placeholder || '—'}</option>
                {f.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </Select>
            ) : f.type === Kind.FILE ? (
              <FileAnswer field={f} labelId={`${id}-label`} disabled={busy} upload={upload} onChange={setList} onPending={setPending} />
            ) : f.type === Kind.PEOPLE ? (
              <PeopleAnswer
                field={f}
                inputId={id}
                labelId={`${id}-label`}
                disabled={busy}
                people={people?.find((p) => p.fieldId === f.id)?.people}
                selected={multiValues[f.id]}
                onChange={setList}
              />
            ) : f.type === Kind.MULTISELECT ? (
              <fieldset
                aria-labelledby={`${id}-label`}
                aria-describedby={`${id}-hint`}
                aria-invalid={bad === f.id}
                className="flex flex-col gap-2"
              >
                {f.options.map((option) => (
                  <label key={option} className="flex min-h-8 items-center gap-2 text-body">
                    <input
                      type="checkbox"
                      className="size-5 shrink-0 accent-[var(--color-accent)]"
                      disabled={busy}
                      checked={multiValues[f.id]?.includes(option) ?? false}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setMultiValues((old) => ({
                          ...old,
                          [f.id]: checked ? [...(old[f.id] ?? []), option] : (old[f.id] ?? []).filter((v) => v !== option),
                        }));
                      }}
                    />
                    {option}
                  </label>
                ))}
              </fieldset>
            ) : f.type === Kind.CHECKBOX ? (
              <input
                {...props}
                type="checkbox"
                className="size-5 accent-[var(--color-accent)]"
                checked={value === 'true'}
                onChange={(e) => update(String(e.target.checked))}
              />
            ) : (
              <Input
                {...props}
                type={
                  f.type === Kind.URL
                    ? 'url'
                    : f.type === Kind.PHONE
                      ? 'tel'
                      : f.type === Kind.EMAIL
                        ? 'email'
                        : f.type === Kind.NUMBER
                          ? 'number'
                          : f.type === Kind.DATE
                            ? 'date'
                            : 'text'
                }
                step="any"
                maxLength={f.type === Kind.PHONE ? 64 : 2000}
                autoComplete={f.type === Kind.PHONE ? 'tel' : undefined}
                placeholder={f.placeholder}
                value={value}
                onChange={(e) => update(e.target.value)}
              />
            )}
            <p id={`${id}-hint`} className={bad === f.id ? 'text-caption text-danger-text' : 'text-caption text-muted'}>
              {bad === f.id ? error : f.hint}
            </p>
          </div>
        );
      })}
      {error ? (
        <p role="alert" className="text-body text-danger-text">
          {error}
        </p>
      ) : null}
      <Button type="submit" busy={busy} className="self-start">
        {t('forms.submit')}
      </Button>
    </form>
  );
}

interface Staged {
  key: number;
  name: string;
  progress: number;
  id?: string;
  error?: string;
  abort?: () => void;
}

/** A FILE answer: picked files upload at once (with progress); the answer is their upload ids. */
const FileAnswer = memo(function FileAnswer({
  field,
  labelId,
  disabled,
  upload,
  onChange,
  onPending,
}: {
  field: BoardFormField;
  labelId: string;
  disabled: boolean;
  upload: FormUpload | undefined;
  onChange: (fieldId: string, ids: string[]) => void;
  onPending: (fieldId: string, n: number) => void;
}): ReactNode {
  const [items, setItems] = useState<Staged[]>([]);
  const [note, setNote] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const limit = maxFiles(field);
  const maxMb = field.maxFileMb || 100;
  // The list lives in a ref too: upload callbacks patch the latest one, not a stale render's.
  const latest = useRef<Staged[]>([]);
  const commit = (next: Staged[]): void => {
    latest.current = next;
    setItems(next);
    onChange(
      field.id,
      next.flatMap((x) => (x.id ? [x.id] : [])),
    );
    onPending(field.id, next.filter((x) => !x.id && !x.error).length);
  };
  const patch = (key: number, p: Partial<Staged>): void => commit(latest.current.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const add = (files: FileList | null): void => {
    if (!files) return;
    setNote('');
    let next = [...latest.current];
    for (const file of Array.from(files)) {
      if (next.length >= limit) {
        setNote(t('forms.tooManyFiles', { n: limit }));
        break;
      }
      if (file.size > maxMb * 1024 * 1024) {
        setNote(t('forms.fileTooLarge', { mb: maxMb }));
        continue;
      }
      const key = ++seq.current;
      if (!upload) {
        next = [...next, { key, name: file.name, progress: 1, id: file.name }];
        continue;
      }
      const h = upload(field.id, file, (fraction) => patch(key, { progress: fraction }));
      next = [...next, { key, name: file.name, progress: 0, abort: () => h.abort() }];
      h.promise.then(
        (id) => patch(key, { id, progress: 1, abort: undefined }),
        (e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          patch(key, {
            error: e instanceof ApiError && e.status === 422 ? t('forms.fileType') : e instanceof ApiError && e.status === 413 ? t('forms.fileTooLarge', { mb: maxMb }) : t('forms.error'),
            abort: undefined,
          });
        },
      );
    }
    commit(next);
  };
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2">
      {items.map((x) => (
        <div key={x.key} className="flex min-h-9 items-center gap-2 rounded-[var(--radius-control)] border border-line px-3 py-1.5">
          <Paperclip className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-body">{x.name}</span>
          {x.error ? (
            <span className="text-caption text-danger-text">{x.error}</span>
          ) : !x.id ? (
            <progress className="h-1.5 w-20 accent-[var(--color-accent)]" max={1} value={x.progress} aria-label={t('forms.uploading')} />
          ) : null}
          <button
            type="button"
            className="grid size-7 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-hover"
            aria-label={t('forms.removeFile')}
            disabled={disabled}
            onClick={() => {
              x.abort?.();
              commit(latest.current.filter((y) => y.key !== x.key));
            }}
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
      <input
        ref={input}
        type="file"
        hidden
        multiple={field.multiple}
        accept={field.accept.map((c) => ACCEPT[c] ?? '').filter(Boolean).join(',') || undefined}
        onChange={(e) => {
          add(e.target.files);
          e.target.value = '';
        }}
      />
      {items.length < limit ? (
        <Button type="button" variant="secondary" className="self-start" disabled={disabled} onClick={() => input.current?.click()}>
          <Paperclip className="size-4" />
          {t('forms.attach')}
        </Button>
      ) : null}
      {note ? <p className="text-caption text-danger-text">{note}</p> : null}
    </div>
  );
});

/** A PEOPLE answer: one person (select) or several (search + checkboxes); names only. */
const PeopleAnswer = memo(function PeopleAnswer({
  field,
  inputId,
  labelId,
  disabled,
  people,
  selected,
  onChange,
}: {
  field: BoardFormField;
  inputId: string;
  labelId: string;
  disabled: boolean;
  people: BoardFormPerson[] | undefined;
  selected: string[] | undefined;
  onChange: (fieldId: string, ids: string[]) => void;
}): ReactNode {
  const [search, setSearch] = useState('');
  const list = people ?? [];
  if (!field.multiple)
    return (
      <Select id={inputId} disabled={disabled} value={selected?.[0] ?? ''} onChange={(e) => onChange(field.id, e.target.value ? [e.target.value] : [])}>
        <option value="">{field.placeholder || t('forms.choosePerson')}</option>
        {list.map((p) => (
          <option key={p.userId} value={p.userId}>
            {p.name}
          </option>
        ))}
      </Select>
    );
  const q = search.trim().toLocaleLowerCase();
  const chosen = selected ?? [];
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2">
      {list.length > 8 ? <Input aria-label={t('forms.searchPeople')} placeholder={t('forms.searchPeople')} value={search} onChange={(e) => setSearch(e.target.value)} /> : null}
      <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
        {list
          .filter((p) => !q || p.name.toLocaleLowerCase().includes(q) || chosen.includes(p.userId))
          .map((p) => (
            <label key={p.userId} className="flex min-h-8 items-center gap-2 text-body">
              <input
                type="checkbox"
                className="size-5 shrink-0 accent-[var(--color-accent)]"
                disabled={disabled || (!chosen.includes(p.userId) && chosen.length >= 10)}
                checked={chosen.includes(p.userId)}
                onChange={(e) => onChange(field.id, e.target.checked ? [...chosen, p.userId] : chosen.filter((u) => u !== p.userId))}
              />
              {p.name}
            </label>
          ))}
      </div>
    </div>
  );
});
