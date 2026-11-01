import { Fragment, memo, type ReactNode } from 'react';
import { CodeBlock } from './CodeBlock';
import { splitHits } from './highlight';
import { parseMarkdown, type MdNode } from './parse';
import { openContentLink as open } from '../../services/contentLink';
import { useLocale } from '../../i18n';

/** Search hits inside a message (in-room search): words to mark; `current` = the hit being viewed. */
export interface MdHighlight {
  words: string[];
  current: boolean;
}

function marked(text: string, hl: MdHighlight | undefined, k: string): ReactNode {
  if (!hl) return text;
  const parts = splitHits(text, hl.words);
  if (parts.length === 1) return text;
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <mark key={`${k}m${i}`} className={hl.current ? 'search-hit search-hit-current' : 'search-hit'}>
        {p}
      </mark>
    ) : (
      p
    ),
  );
}

function render(nodes: MdNode[], mention: MentionRenderer, key = '', hl?: MdHighlight): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case 'text':
        return hl ? <Fragment key={k}>{marked(n.v, hl, k)}</Fragment> : n.v;
      case 'br':
        return <br key={k} />;
      case 'code':
        return (
          <code key={k} className="rounded bg-code px-1 py-px font-mono text-[0.88em]">
            {n.v}
          </code>
        );
      case 'codeblock':
        return <CodeBlock key={k} code={n.v} lang={n.lang} />;
      case 'b':
        return <strong key={k}>{render(n.c, mention, `${k}.`, hl)}</strong>;
      case 'i':
        return <em key={k}>{render(n.c, mention, `${k}.`, hl)}</em>;
      case 's':
        return <s key={k}>{render(n.c, mention, `${k}.`, hl)}</s>;
      case 'link':
        return (
          <a
            key={k}
            href={n.href}
            title={n.href}
            onClick={(e) => {
              e.preventDefault();
              open(n.href);
            }}
            className="text-accent-text hover:underline mobile:underline"
          >
            {render(n.c, mention, `${k}.`, hl)}
          </a>
        );
      case 'mention':
        return mention(n.v, k);
      default:
        return null;
    }
  });
}

/** Renders a mention node (`v`: user id, 'everyone' or 'here'); the caller knows the names. */
export type MentionRenderer = (v: string, key: string) => ReactNode;

export const Markdown = memo(function Markdown({ text, mention, highlight }: { text: string; mention: MentionRenderer; highlight?: MdHighlight | undefined }): ReactNode {
  // Memo row: re-render on a language switch too (ADR-0022).
  useLocale();
  return <>{render(parseMarkdown(text), mention, '', highlight)}</>;
});
