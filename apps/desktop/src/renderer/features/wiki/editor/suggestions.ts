/**
 * The suggestion popovers: `/` blocks, `@` people and `[[` pages. Tiptap's suggestion plugin tracks the
 * query; its render hooks only write the shared MenuStore (no DOM here), <SuggestionMenu> draws it.
 */
import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { Suggestion, type SuggestionOptions, type SuggestionProps } from '@tiptap/suggestion';
import type { MentionCandidate } from '../../../lib/mentions';
import { filterBlocks, type BlockDef } from './blocks';
import type { EditorEnv } from './env';
import { rectOf } from './menuStore';
import type { PageCandidate } from './types';

function renderInto<T>(env: EditorEnv, kind: 'slash' | 'mention' | 'page'): SuggestionOptions<T, T>['render'] {
  return () => {
    let index = 0;
    const show = (p: SuggestionProps<T, T>): void => {
      const prev = env.menu.get();
      // Keep the highlighted row while the list stays the same length (typing narrows it).
      index = prev?.kind === kind && prev.items.length === p.items.length ? prev.index : 0;
      env.menu.set({ kind, items: p.items, index, rect: rectOf(p.clientRect), pick: (item) => p.command(item as T) });
    };
    return {
      onStart: show,
      onUpdate: show,
      onExit: () => env.menu.set(null),
      onKeyDown: ({ event }) => env.menu.key(event),
    };
  };
}

export function mentionSuggestion(env: EditorEnv): Omit<SuggestionOptions<MentionCandidate, MentionCandidate>, 'editor'> {
  return {
    char: '@',
    pluginKey: new PluginKey('wikiMention'),
    allow: ({ editor }) => !editor.isActive('codeBlock') && !!env.mentions,
    items: ({ query }) => env.mentions?.search(query) ?? [],
    command: ({ editor, range, props }) => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          { type: 'mention', attrs: { id: props.id, label: props.name } },
          { type: 'text', text: ' ' },
        ])
        .run();
    },
    render: renderInto<MentionCandidate>(env, 'mention'),
  };
}

function runBlock(editor: Editor, range: Range, b: BlockDef): void {
  b.run(editor.chain().focus().deleteRange(range)).run();
}

/** `/` at the start of a word opens the block menu (not inside code). */
export function slashCommands(env: EditorEnv) {
  return Extension.create({
    name: 'wikiSlash',
    addProseMirrorPlugins() {
      return [
        Suggestion<BlockDef, BlockDef>({
          editor: this.editor,
          char: '/',
          pluginKey: new PluginKey('wikiSlash'),
          allowSpaces: false,
          allow: ({ editor }) => editor.isEditable && !editor.isActive('codeBlock'),
          items: ({ query, editor }) => filterBlocks(query).filter((b) => (b.id !== 'image' || (!!env.upload && editor.isEditable)) && (b.id !== 'pageLink' || !!env.pages)),
          command: ({ editor, range, props }) => runBlock(editor, range, props),
          render: renderInto<BlockDef>(env, 'slash'),
        }),
      ];
    },
  });
}

/** How long the `[[` picker waits after a keystroke before asking the server. */
const REMOTE_DELAY_MS = 200;
const PAGE_ROWS = 10;

/**
 * `[[` opens the page picker (owner 14.10): loaded pages at once, the server search (`type=wiki`)
 * merged in after a pause in typing; the pick replaces `[[query` with a page link.
 */
export function pageLinks(env: EditorEnv) {
  return Extension.create({
    name: 'wikiPageLinks',
    addProseMirrorPlugins() {
      const base = renderInto<PageCandidate>(env, 'page');
      return [
        Suggestion<PageCandidate, PageCandidate>({
          editor: this.editor,
          char: '[[',
          pluginKey: new PluginKey('wikiPageLinks'),
          allowSpaces: true,
          allowedPrefixes: null,
          allow: ({ editor }) => editor.isEditable && !editor.isActive('codeBlock') && !!env.pages,
          items: ({ query }) => env.pages?.search(query).slice(0, PAGE_ROWS) ?? [],
          command: ({ editor, range, props }) => {
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                { type: 'wikiPageLink', attrs: { pageId: props.id } },
                { type: 'text', text: ' ' },
              ])
              .run();
          },
          render: () => {
            const r = base?.() ?? {};
            let timer: ReturnType<typeof setTimeout> | undefined;
            let ctl: AbortController | null = null;
            let query = '';
            /** The server's hits for `query` (kept so a re-render of the local list keeps them). */
            let found: PageCandidate[] = [];
            const stop = (): void => {
              clearTimeout(timer);
              ctl?.abort();
              ctl = null;
            };
            const merge = (): void => {
              const st = env.menu.get();
              if (st?.kind !== 'page' || !found.length) return;
              const have = st.items as PageCandidate[];
              const ids = new Set(have.map((p) => p.id));
              const extra = found.filter((p) => !ids.has(p.id));
              if (extra.length) env.menu.set({ ...st, items: [...have, ...extra].slice(0, PAGE_ROWS) });
            };
            // The server's hits for this query join the list (deduplicated) while it is still open on it.
            const remote = (q: string): void => {
              stop();
              query = q;
              found = [];
              const src = env.pages;
              if (!src || !q.trim()) return;
              timer = setTimeout(() => {
                const c = new AbortController();
                ctl = c;
                src.remote(q, c.signal).then(
                  (hits) => {
                    if (c.signal.aborted || query !== q) return;
                    found = hits;
                    merge();
                  },
                  () => undefined,
                );
              }, REMOTE_DELAY_MS);
            };
            return {
              ...r,
              onStart: (p: SuggestionProps<PageCandidate, PageCandidate>) => {
                r.onStart?.(p);
                remote(p.query);
              },
              onUpdate: (p: SuggestionProps<PageCandidate, PageCandidate>) => {
                r.onUpdate?.(p);
                if (p.query !== query) remote(p.query);
                else merge();
              },
              onExit: (p: SuggestionProps<PageCandidate, PageCandidate>) => {
                stop();
                r.onExit?.(p);
              },
            };
          },
        }),
      ];
    },
  });
}
