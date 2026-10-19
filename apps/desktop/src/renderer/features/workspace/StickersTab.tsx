import type { Sticker, StickerPack } from '@calaba/protocol';
import * as Dropdown from '../../components/radix/dropdown-menu';
import { ChevronLeft, ChevronRight, Ellipsis, ImageUp, Plus, SmilePlus, Star, Trash2, Upload, X } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, Empty, IconButton, Input, Row, Spinner, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { describeError, errorText } from '../../lib/api/errors';
import { fmt } from '../../lib/format';
import { api, replaceSticker, uploadStickers } from '../../lib/api/endpoints';
import { STICKER_ACCEPT, prepareSticker, stickerFileKind, type PreparedSticker } from '../../lib/stickerPrepare';
import { STICKER_BATCH, coverOf, stickerBox } from '../../lib/stickers';
import { loadWorkspaceStickers } from '../../services/stickers';
import { reportPlanError } from '../../services/plan';
import { useStickers } from '../../stores/stickers';
import { useWorkspaces } from '../../stores/workspaces';
import { atLimit } from '../../lib/plan';
import { PlanFullNote } from './PlanTab';
import { CommitInput } from '../settings/CommitInput';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { StickerImage, StickerStill } from '../chat/stickers/StickerImage';
import { EmojiPicker } from '../chat/EmojiPicker';
import { applyEmojiTo, suggestStickerEmoji } from './stickerEmoji';

/*
 * Workspace settings → «Стикеры» (ADR-0030, docs/08 «Стикеры»), MANAGE_STICKERS: the packs
 * (cover, name, count) and «Новый пак»; a pack card — rename, drop PNG / JPEG / WebP files in a
 * batch (prepared by lib/stickerPrepare: scaled to 512, encoded to WebP; each gets an emoji before
 * the upload), the stickers with their emoji, «Сделать обложкой», delete. Changes apply at once;
 * the server validates every file (a refusal shows on that file's card).
 */

const err = (e: unknown): string => errorText(e);
const NO_PACKS: StickerPack[] = [];

export function StickersTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const packs = useStickers((s) => s.byWorkspace[workspaceId] ?? NO_PACKS);
  const loaded = useStickers((s) => workspaceId in s.byWorkspace);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    void loadWorkspaceStickers(workspaceId);
  }, [workspaceId]);
  const pack = open ? packs.find((p) => p.id === open) : undefined;
  if (pack) return <PackCard workspaceId={workspaceId} pack={pack} onBack={() => setOpen(null)} />;
  return <PackList workspaceId={workspaceId} packs={packs} loaded={loaded} onOpen={setOpen} />;
}

function PackList({ workspaceId, packs, loaded, onOpen }: { workspaceId: string; packs: StickerPack[]; loaded: boolean; onOpen: (id: string) => void }): ReactNode {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plan's sticker packs (owner 28.09: free = 1): «Создать» locks at the limit.
  const limit = useWorkspaces((s) => s.byId[workspaceId]?.ws.plan?.limits?.stickerPacks ?? 0);
  const full = loaded && atLimit(packs.length, limit);
  const create = async (): Promise<void> => {
    const v = name.trim();
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.stickers.create(workspaceId, { name: v });
      if (r.pack) {
        useStickers.getState().upsert(r.pack);
        setName('');
        onOpen(r.pack.id);
      }
    } catch (e) {
      if (!reportPlanError(e, workspaceId)) setError(err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="text-caption text-muted">{t('stk.hint')}</p>
      <Card title={t('stk.newPack')}>
        <form
          className="flex items-center gap-2 px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            placeholder={t('stk.namePlaceholder')}
            aria-label={t('stk.name')}
            className="min-w-0 flex-1"
            data-testid="sticker-pack-name"
          />
          <Button type="submit" busy={busy} disabled={!name.trim() || full} data-testid="sticker-pack-create">
            <Plus className="size-4" aria-hidden /> {t('stk.create')}
          </Button>
        </form>
        {full ? (
          <div className="px-2 pb-2.5">
            <PlanFullNote text={plural('stk.planPacks', limit)} testId="sticker-plan-full" />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="px-3 pb-2.5 text-caption text-danger-text">
            {error}
          </p>
        ) : null}
      </Card>
      {loaded && packs.length === 0 ? (
        <Empty>{t('stk.noPacks')}</Empty>
      ) : (
        <Card title={t('stk.tab')}>
          {packs.map((p) => {
            const c = coverOf(p);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onOpen(p.id)}
                className="flex min-h-12 w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-hover"
                data-testid="sticker-pack-row"
              >
                {c ? <StickerImage sticker={c} size={36} /> : <span className="size-9 rounded-[var(--radius-card)] bg-[var(--color-fill)]" aria-hidden />}
                <span className="min-w-0 flex-1 truncate text-body font-medium">{p.name}</span>
                <span className="shrink-0 text-caption text-muted">{plural('stk.count', p.stickers.length, { n: p.stickers.length })}</span>
                <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
              </button>
            );
          })}
        </Card>
      )}
    </>
  );
}

/** A file on its way to the pack: being prepared, ready (waiting for the upload) or refused. */
interface Staged {
  key: string;
  /** Preview: the prepared WebP once ready, the original file before. */
  url: string;
  emoji: string;
  /** An animated WebP: its preview stands still (docs/14 — the CPU budget of animations). */
  animated?: boolean;
  sticker?: PreparedSticker;
  /** Refused by the client (prepare) or the server (`file[i]`): not uploaded. */
  fileError?: string;
  /** The server refused its emoji (`emoji[i]`): cleared by editing the emoji. */
  emojiError?: string;
}

const without = (s: ReadonlySet<string>, keys: Iterable<string>): ReadonlySet<string> => {
  const out = new Set(s);
  for (const k of keys) out.delete(k);
  return out.size === s.size ? s : out;
};
const uploadable = (s: Staged): s is Staged & { sticker: PreparedSticker } => !!s.sticker && !s.fileError;

function PackCard({ workspaceId, pack, onBack }: { workspaceId: string; pack: StickerPack; onBack: () => void }): ReactNode {
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<Staged[]>([]);
  // «Применить эмодзи ко всем выбранным» (docs/09 #79): checkbox or ⌘ / Ctrl-click on a card.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [progress, setProgress] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const cover = coverOf(pack)?.id;
  // Object URLs of the previews: released when a card goes away (and on unmount).
  const urls = useRef(new Set<string>());
  const preview = (b: Blob): string => {
    const u = URL.createObjectURL(b);
    urls.current.add(u);
    return u;
  };
  const release = useCallback((u: string): void => {
    if (urls.current.delete(u)) URL.revokeObjectURL(u);
  }, []);
  useEffect(() => {
    const all = urls.current;
    return () => all.forEach((u) => URL.revokeObjectURL(u));
  }, []);
  const patch = (key: string, f: (s: Staged) => Staged): void => setStaged((cur) => cur.map((x) => (x.key === key ? f(x) : x)));
  // Stable callbacks for the memoised cards: a pick re-renders only its own card.
  const unstage = useCallback(
    (key: string): void => {
      setStaged((cur) => {
        const gone = cur.find((x) => x.key === key);
        if (gone) release(gone.url);
        return cur.filter((x) => x.key !== key);
      });
      setSelected((cur) => without(cur, [key]));
    },
    [release],
  );
  const setEmoji = useCallback((key: string, emoji: string): void => setStaged((cur) => applyEmojiTo(cur, new Set([key]), emoji)), []);
  const toggle = useCallback((key: string): void => setSelected((cur) => (cur.has(key) ? without(cur, [key]) : new Set([...cur, key]))), []);
  const selectable = staged.filter((s) => !s.fileError);
  const picked = selectable.filter((s) => selected.has(s.key));
  const allPicked = selectable.length > 0 && picked.length === selectable.length;
  const applyToSelected = (emoji: string): void => setStaged((cur) => applyEmojiTo(cur, new Set(picked.map((s) => s.key)), emoji));

  const apply = (p: StickerPack | undefined): void => {
    if (p) useStickers.getState().upsert(p);
  };
  const run = async (f: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await f();
    } catch (e) {
      if (!reportPlanError(e, workspaceId)) setError(err(e));
    }
  };
  // Files are prepared one by one in the background (scaled / encoded to WebP, docs/08
  // «Стикеры»); a refusal stays on its card, the other cards are unaffected.
  const stage = (files: FileList | File[]): void => {
    const next: Array<Staged & { file: File }> = [];
    const problems: string[] = [];
    const room = STICKER_BATCH - staged.length;
    for (const f of Array.from(files)) {
      const kind = stickerFileKind(f.name, f.type);
      if (kind === 'gif') problems.push(t('stk.gifDrop', { name: f.name }));
      else if (kind === 'other') problems.push(t('stk.notImage', { name: f.name }));
      else if (next.length < room) next.push({ key: `${f.name}-${f.size}-${f.lastModified}-${Math.random()}`, file: f, url: preview(f), emoji: suggestStickerEmoji(f.name) });
    }
    setError(problems.length ? problems.join(' · ') : null);
    if (!next.length) return;
    setStaged((cur) => [...cur, ...next.map(({ file: _file, ...s }) => s)]);
    void (async () => {
      for (const s of next) {
        const r = await prepareSticker(s.file);
        if (!r.ok) {
          patch(s.key, (x) => ({ ...x, animated: r.sniff?.animated, fileError: t(`stk.reject.${r.reason}`) }));
          continue;
        }
        const url = r.sticker.blob === s.file ? s.url : preview(r.sticker.blob);
        setStaged((cur) => {
          if (!cur.some((x) => x.key === s.key)) {
            release(url);
            return cur;
          }
          if (url !== s.url) release(s.url);
          return cur.map((x) => (x.key === s.key ? { ...x, url, animated: r.sticker.animated, sticker: r.sticker } : x));
        });
      }
    })();
  };
  const preparing = staged.some((s) => !s.sticker && !s.fileError);
  const ready = staged.filter(uploadable);
  const upload = (): Promise<void> =>
    run(async () => {
      const batch = ready;
      setProgress(0);
      try {
        const r = await uploadStickers(
          pack.id,
          batch.map((s) => ({ file: s.sticker.blob, name: s.sticker.name, emoji: s.emoji })),
          setProgress,
        );
        apply(r.pack);
        const sent = new Set(batch.map((s) => s.key));
        setStaged((cur) => {
          for (const x of cur) if (sent.has(x.key)) release(x.url);
          return cur.filter((x) => !sent.has(x.key));
        });
        setSelected((cur) => without(cur, sent));
      } catch (e) {
        // `file[i]` / `emoji[i]`: the reason goes on that card; the batch stays staged.
        const h = describeError(e);
        const bad = h.index !== undefined ? batch[h.index] : undefined;
        if (!bad) throw e;
        patch(bad.key, (x) => (h.field === 'emoji' ? { ...x, emojiError: h.text } : { ...x, fileError: h.text }));
      } finally {
        setProgress(null);
      }
    });
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length) stage(e.dataTransfer.files);
  };
  const remove = async (): Promise<void> => {
    if (!(await confirmAction(t('stk.deletePackTitle', { name: pack.name }), t('stk.deletePackBody'), t('stk.deletePack')))) return;
    await run(async () => {
      await api.stickers.remove(pack.id);
      useStickers.getState().removePack(workspaceId, pack.id);
      onBack();
    });
  };

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onBack} data-testid="sticker-back">
          <ChevronLeft className="size-4" aria-hidden /> {t('stk.tab')}
        </Button>
        <h3 className="min-w-0 truncate text-headline font-semibold" data-testid="sticker-pack-title">
          {pack.name}
        </h3>
        <span className="shrink-0 text-caption text-muted">{plural('stk.count', pack.stickers.length, { n: pack.stickers.length })}</span>
      </div>
      {error ? (
        <p role="alert" className="-mt-2 text-caption text-danger-text" data-testid="sticker-error">
          {error}
        </p>
      ) : null}
      <Card>
        <Row label={t('stk.name')}>
          <CommitInput value={pack.name} label={t('stk.name')} maxLength={64} onCommit={(v) => run(async () => apply((await api.stickers.update(pack.id, { name: v })).pack))} />
        </Row>
      </Card>

      <div
        className={cx(
          'flex flex-col items-center gap-2 rounded-[var(--radius-card)] border border-dashed px-4 py-5 text-center transition-colors duration-[var(--motion-fast)]',
          over ? 'border-accent bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]' : 'border-line',
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        data-testid="sticker-drop"
      >
        <Upload className="size-5 text-muted" aria-hidden />
        <p className="text-body text-fg">
          {t('stk.drop')} <span className="text-muted">{t('stk.dropOr')}</span>
        </p>
        <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
          {t('stk.pick')}
        </Button>
        <p className="text-caption text-muted">{t('stk.dropHint')}</p>
        <input
          ref={input}
          type="file"
          accept={STICKER_ACCEPT}
          multiple
          hidden
          data-testid="sticker-file-input"
          onChange={(e) => {
            if (e.target.files) stage(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {staged.length ? (
        <Card title={plural('stk.count', staged.length, { n: staged.length })}>
          {staged.length > 1 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 pt-3" data-testid="sticker-staged-bar">
              <label className="flex cursor-pointer items-center gap-2 text-body">
                <input
                  type="checkbox"
                  checked={allPicked}
                  disabled={!selectable.length}
                  onChange={() => setSelected(allPicked ? new Set() : new Set(selectable.map((s) => s.key)))}
                  data-testid="sticker-select-all"
                  className="size-4 cursor-pointer rounded-[4px] accent-[var(--color-accent-strong)]"
                />
                {t('stk.selectAll')}
              </label>
              {picked.length ? <span className="text-caption text-muted tabular-nums">{t('stk.selectedCount', { n: picked.length })}</span> : null}
              <span className="flex-1" />
              <EmojiPicker label={t('stk.applyEmoji')} onPick={applyToSelected} closeOnPick inModal side="top">
                <Button variant="secondary" size="sm" disabled={!picked.length} data-testid="sticker-apply-emoji">
                  <SmilePlus className="size-4" aria-hidden /> {t('stk.applyEmoji')}
                </Button>
              </EmojiPicker>
            </div>
          ) : null}
          <ul className="grid grid-cols-4 gap-2 p-3 mobile:grid-cols-3" data-testid="sticker-staged">
            {staged.map((s) => (
              <StagedCell key={s.key} item={s} selectable={staged.length > 1} selected={selected.has(s.key)} onEmoji={setEmoji} onRemove={unstage} onToggle={toggle} />
            ))}
          </ul>
          <div className="flex items-center justify-end gap-2 px-3 pb-3">
            {progress !== null ? <span className="text-caption text-muted">{t('stk.uploading', { pct: Math.round(progress * 100) })}</span> : null}
            <Button
              busy={progress !== null}
              disabled={preparing || !ready.length || ready.some((s) => !s.emoji.trim() || s.emojiError)}
              onClick={() => void upload()}
              data-testid="sticker-upload"
            >
              <Upload className="size-4" aria-hidden /> {t('stk.upload')}
            </Button>
          </div>
        </Card>
      ) : null}

      {pack.stickers.length ? (
        <Card title={t('stk.tabStickers')}>
          <ul className="grid grid-cols-5 gap-2 p-3 mobile:grid-cols-3" data-testid="sticker-pack-stickers">
            {pack.stickers.map((s) => (
              <StickerCell
                key={s.id}
                sticker={s}
                cover={s.id === cover}
                onEmoji={(v) => run(async () => apply((await api.stickers.setEmoji(s.id, v)).pack))}
                onCover={() => run(async () => apply((await api.stickers.update(pack.id, { coverStickerId: s.id })).pack))}
                onDelete={() => run(async () => apply((await api.stickers.removeSticker(s.id)).pack))}
                onReplaced={apply}
              />
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="flex justify-end">
        <Button variant="destructive" onClick={() => void remove()} data-testid="sticker-pack-delete">
          <Trash2 className="size-4" aria-hidden /> {t('stk.deletePack')}
        </Button>
      </div>
    </>
  );
}

/**
 * A staged file: preview, «512×512 · 84 КБ», «уменьшено до 512», its emoji or why it is refused.
 * In a batch a checkbox (or ⌘ / Ctrl-click on the card) selects it for «Применить ко всем».
 */
const StagedCell = memo(function StagedCell({
  item,
  selectable,
  selected,
  onEmoji,
  onRemove,
  onToggle,
}: {
  item: Staged;
  selectable: boolean;
  selected: boolean;
  onEmoji: (key: string, v: string) => void;
  onRemove: (key: string) => void;
  onToggle: (key: string) => void;
}): ReactNode {
  const { key, sticker, fileError, emojiError } = item;
  const problem = fileError ?? emojiError;
  const canSelect = selectable && !fileError;
  return (
    <li
      className={cx(
        'relative flex min-w-0 flex-col items-center gap-1 rounded-[var(--radius-card)] p-1',
        selected && canSelect && 'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] outline-2 outline-accent',
      )}
      data-testid="sticker-staged-item"
      data-state={fileError ? 'error' : sticker ? 'ready' : 'preparing'}
      data-selected={(selected && canSelect) || undefined}
      onClickCapture={(e) => {
        if (!canSelect || !(e.metaKey || e.ctrlKey)) return;
        // ⌘ / Ctrl-click anywhere on the card toggles it (and does not open the picker).
        e.preventDefault();
        e.stopPropagation();
        onToggle(key);
      }}
    >
      {canSelect ? (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(key)}
          aria-label={t('stk.selectFile')}
          data-testid="sticker-staged-select"
          className="absolute left-1 top-1 z-[1] size-4 cursor-pointer rounded-[4px] accent-[var(--color-accent-strong)]"
        />
      ) : null}
      <span className={cx('grid size-16 place-items-center', fileError && 'opacity-40')}>
        {item.animated ? (
          <StickerStill src={item.url} {...stickerBox({ width: sticker?.width ?? 0, height: sticker?.height ?? 0 }, 64)} />
        ) : item.animated === undefined && !sticker && !fileError ? null : (
          <img src={item.url} alt="" className="size-full object-contain" draggable={false} />
        )}
      </span>
      {!fileError ? <EmojiField value={item.emoji} onPick={(v) => onEmoji(key, v)} /> : null}
      {sticker ? (
        <span className="text-center text-caption text-muted tabular-nums">{t('stk.dims', { w: sticker.width, h: sticker.height, size: fmt.size(sticker.size) })}</span>
      ) : !fileError ? (
        <span className="text-caption text-muted">{t('stk.preparing')}</span>
      ) : null}
      {sticker?.scaled && !fileError ? (
        <span className="inline-flex h-[15px] items-center rounded-full bg-hover px-1.5 text-[10px] font-semibold leading-none text-fg" data-testid="sticker-scaled">
          {t('stk.scaled')}
        </span>
      ) : null}
      {problem ? (
        <p role="alert" className="text-center text-caption text-danger-text" data-testid="sticker-item-error">
          {problem}
        </p>
      ) : null}
      <IconButton size="sm" label={t('stk.unstage')} className="absolute -right-1 -top-1" onClick={() => onRemove(key)}>
        <X className="size-3.5" aria-hidden />
      </IconButton>
    </li>
  );
});

function StickerCell({
  sticker,
  cover,
  onEmoji,
  onCover,
  onDelete,
  onReplaced,
}: {
  sticker: Sticker;
  cover: boolean;
  onEmoji: (v: string) => Promise<void>;
  onCover: () => Promise<void>;
  onDelete: () => Promise<void>;
  onReplaced: (p: StickerPack | undefined) => void;
}): ReactNode {
  const file = useRef<HTMLInputElement>(null);
  const emoji = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // «Заменить файл»: the same preparation as an upload, then PUT …/stickers/{id} (id, emoji and
  // position stay); a refusal shows under this sticker.
  const replace = async (f: File): Promise<void> => {
    setProblem(null);
    const kind = stickerFileKind(f.name, f.type);
    if (kind === 'gif' || kind === 'other') {
      setProblem(t(kind === 'gif' ? 'stk.reject.gif' : 'stk.reject.unsupported'));
      return;
    }
    setBusy(true);
    try {
      const r = await prepareSticker(f);
      if (!r.ok) {
        setProblem(t(`stk.reject.${r.reason}`));
        return;
      }
      onReplaced((await replaceSticker(sticker.packId, sticker.id, { file: { blob: r.sticker.blob, name: r.sticker.name } })).pack);
    } catch (e) {
      const h = describeError(e);
      setProblem(h.field === 'emoji' ? t('stk.err.emoji') : h.text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="group relative flex flex-col items-center gap-1 rounded-[var(--radius-card)] p-1 hover:bg-hover focus-within:bg-hover" data-testid="sticker-cell">
      <span className={cx('grid place-items-center', busy && 'opacity-40')}>
        <StickerImage sticker={sticker} size={64} />
      </span>
      {busy ? <Spinner className="absolute left-1/2 top-8 -translate-x-1/2 -translate-y-1/2" /> : null}
      <EmojiField value={sticker.emoji} onPick={(v) => void onEmoji(v)} chipRef={emoji} />
      {problem ? (
        <p role="alert" className="text-center text-caption text-danger-text" data-testid="sticker-item-error">
          {problem}
        </p>
      ) : null}
      {cover ? (
        <span className="absolute left-1 top-1 grid size-5 place-items-center rounded-full bg-accent-strong text-accent-fg" title={t('stk.cover')}>
          <Star className="size-3" aria-label={t('stk.cover')} />
        </span>
      ) : null}
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <IconButton
            size="sm"
            label={t('stk.actions')}
            className="absolute right-0 top-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 mobile:opacity-100"
            data-testid="sticker-actions"
          >
            <Ellipsis className="size-3.5" aria-hidden />
          </IconButton>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content align="end" sideOffset={4} collisionPadding={16} className={menuBox}>
            <Dropdown.Item className={menuItem} onSelect={() => file.current?.click()}>
              <ImageUp className="size-4" aria-hidden /> {t('stk.replace')}
            </Dropdown.Item>
            <Dropdown.Item
              className={menuItem}
              // After the menu has closed and returned the focus to its trigger: open the picker.
              onSelect={() => setTimeout(() => emoji.current?.click(), 0)}
            >
              <SmilePlus className="size-4" aria-hidden /> {t('stk.editEmoji')}
            </Dropdown.Item>
            {!cover ? (
              <Dropdown.Item className={menuItem} onSelect={() => void onCover()}>
                <Star className="size-4" aria-hidden /> {t('stk.makeCover')}
              </Dropdown.Item>
            ) : null}
            <Dropdown.Separator className={menuSeparator} />
            <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void onDelete()}>
              <Trash2 className="size-4" aria-hidden /> {t('common.delete')}
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      <input
        ref={file}
        type="file"
        accept={STICKER_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void replace(f);
        }}
      />
    </li>
  );
}

/**
 * One emoji for a sticker (docs/09 #79): a 28 px chip with the current emoji; a click (Enter /
 * Space) opens the shared EmojiPicker above it, a pick sets the emoji and closes it, Esc closes.
 * Typing by hand stays as a fallback — the picker's search accepts a pasted emoji. The settings
 * sheet is a modal: the picker takes the --z-modal-popover layer (styles.css).
 */
function EmojiField({ value, onPick, chipRef }: { value: string; onPick: (v: string) => void; chipRef?: RefObject<HTMLButtonElement | null> }): ReactNode {
  return (
    <EmojiPicker label={t('stk.emojiFor')} onPick={(e) => e !== value && onPick(e)} closeOnPick inModal side="top">
      <button
        ref={chipRef}
        type="button"
        aria-label={t('stk.emojiFor')}
        data-testid="sticker-emoji"
        className="grid size-7 place-items-center rounded-full bg-[var(--color-fill)] text-[16px] leading-none hover:bg-hover data-[state=open]:bg-hover"
      >
        {value}
      </button>
    </EmojiPicker>
  );
}
