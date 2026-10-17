import { Copy } from 'lucide-react';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Tip } from '../../components/ui';
import { useDisclosure } from '../disclosure';
import { plural, t } from '../../i18n';
import { toast } from '../../stores/toasts';
import { clipLines } from './parse';
import { cachedHighlight, grammarId, highlightIdle, type HlNode } from './syntax';

/** Longer blocks show this many lines and «Показать всё» (docs/08, «Код в сообщениях»). */
export const MAX_LINES = 400;

function runs(nodes: HlNode[], key: string): ReactNode[] {
  return nodes.map((n, i) =>
    typeof n === 'string' ? (
      n
    ) : (
      <span key={`${key}${i}`} className={`syn-${n.c}`}>
        {runs(n.v, `${key}${i}.`)}
      </span>
    ),
  );
}

/**
 * A fenced code block (Telegram-like): language label and «Копировать» in the top-right corner,
 * monospace, no wrapping (horizontal scroll), highlighted when the language is known. The text
 * renders plain first; highlighting arrives from idle time with the same metrics, so the
 * virtualized feed never jumps. Memoized by content.
 */
export const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang: string }): ReactNode {
  // Kept by message in the virtualised feed (lib/disclosure.ts): back open, at its cached height.
  const [expanded, setExpanded] = useDisclosure(`code:${code.length}:${code.slice(0, 64)}`);
  const { lines, head } = useMemo(() => clipLines(code, MAX_LINES), [code]);
  const collapsed = lines > MAX_LINES && !expanded;
  const shown = collapsed ? head : code;
  const id = grammarId(lang);
  const [hl, setHl] = useState<{ src: string; nodes: HlNode[] } | null>(null);
  const ready = id ? (hl?.src === shown ? hl.nodes : cachedHighlight(shown, id)) : undefined;

  useEffect(() => {
    if (!id || ready) return;
    let live = true;
    void highlightIdle(shown, id).then((nodes) => {
      if (live && nodes) setHl({ src: shown, nodes });
    });
    return () => {
      live = false;
    };
  }, [shown, id, ready]);

  const copy = (): void => {
    navigator.clipboard.writeText(code).then(
      () => toast.success(t('chat.copied')),
      (e: unknown) => toast.fail(e),
    );
  };

  return (
    <div className="group/code my-1 max-w-full overflow-hidden rounded-[var(--radius-row)] bg-code-block whitespace-normal" data-testid="code-block">
      <div className="flex h-7 items-center justify-end gap-0.5 pl-2.5 pr-1 text-caption text-[color:var(--bubble-meta,var(--color-label-secondary))]">
        <Tip label={t('chat.code.copy')}>
          <button
            type="button"
            aria-label={t('chat.code.copy')}
            onClick={copy}
            data-testid="code-copy"
            className="grid size-6 place-items-center rounded-[var(--radius-icon)] opacity-0 transition-opacity duration-[var(--motion-fast)] hover:bg-hover focus-visible:opacity-100 group-hover/code:opacity-100 pointer-coarse:opacity-100 mobile:opacity-100"
          >
            <Copy className="size-3.5" aria-hidden />
          </button>
        </Tip>
        {lang ? <span className="max-w-[50%] select-none truncate pr-1.5 font-mono">{lang.toLowerCase()}</span> : null}
      </div>
      <pre
        tabIndex={0}
        aria-label={lang ? t('chat.code.labelLang', { lang }) : t('chat.code.label')}
        className="overflow-x-auto px-2.5 pb-2 font-mono text-[12.5px] leading-[18px] whitespace-pre break-normal [overflow-wrap:normal] [tab-size:4] focus-visible:-outline-offset-2"
      >
        <code>{ready ? runs(ready, '') : shown}</code>
      </pre>
      {collapsed ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
          data-feed-expand=""
          className="flex h-8 w-full items-center justify-center border-t border-line text-body font-medium text-accent-text hover:bg-hover"
        >
          {plural('chat.code.showAll', lines, { n: lines })}
        </button>
      ) : null}
    </div>
  );
});
