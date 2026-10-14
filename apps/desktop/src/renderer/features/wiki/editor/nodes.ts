/**
 * Wiki-specific nodes and marks (ADR-0096 §3): callout, toggle, image (file id only), code block
 * with Prism and a language picker, live-labelled mentions, highlight colours by name.
 * Light DOM node views where React is not needed (one React root per node costs).
 */
import { mergeAttributes } from '@tiptap/core';
import { str } from '../../../lib/wiki/markdown';
import { CodeBlock } from '@tiptap/extension-code-block';
import { CalloutNode, HighlightMark, ImageNode, ToggleNode, WikiPageLinkNode } from '@calaba/wiki-doc/schema';
import { Mention } from '@tiptap/extension-mention';
import type { SuggestionOptions } from '@tiptap/suggestion';
import type { Node as PmNode } from '@tiptap/pm/model';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { t } from '../../../i18n';
import { CalloutView, ImageView } from './NodeViews';
import type { EditorEnv } from './env';
import { prismPlugin } from './prismPlugin';
import { mentionSuggestion } from './suggestions';
import { pickImage } from './upload';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    wikiBlocks: {
      setCallout: () => ReturnType;
      setToggle: () => ReturnType;
      pickImage: () => ReturnType;
    };
  }
}

export { DEFAULT_CALLOUT_ICON } from '@calaba/wiki-doc/schema';

export const Callout = CalloutNode.extend<{ env: EditorEnv | null }>({
  addOptions: () => ({ env: null }),
  addCommands() {
    return {
      setCallout:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});

/**
 * Toggle (schema: @calaba/wiki-doc): folding is local (a click on this screen), never in the
 * doc: a co-author folding a block must not fold it for everyone.
 */
export const Toggle = ToggleNode.extend({
  addCommands() {
    return {
      setToggle:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
    };
  },
  addNodeView() {
    return () => {
      const dom = document.createElement('div');
      dom.className = 'wiki-toggle';
      dom.dataset['toggle'] = '';
      dom.dataset['open'] = 'true';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wiki-toggle-btn';
      btn.contentEditable = 'false';
      const label = (): void => {
        const open = dom.dataset['open'] === 'true';
        btn.setAttribute('aria-expanded', String(open));
        btn.setAttribute('aria-label', t(open ? 'wiki.toggle.collapse' : 'wiki.toggle.expand'));
      };
      label();
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        dom.dataset['open'] = dom.dataset['open'] === 'true' ? 'false' : 'true';
        label();
      });
      const contentDOM = document.createElement('div');
      contentDOM.className = 'wiki-toggle-body';
      dom.append(btn, contentDOM);
      return {
        dom,
        contentDOM,
        ignoreMutation: (m) => m.type === 'attributes' && (m.target === dom || m.target === btn),
        stopEvent: (e) => e.target === btn,
      };
    };
  },
});

/** Languages offered by the picker (grammar ids of lib/markdown/syntax; '' = plain text). */
export const CODE_LANGUAGES: ReadonlyArray<[string, string]> = [
  ['', ''],
  ['bash', 'Bash'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['css', 'CSS'],
  ['go', 'Go'],
  ['html', 'HTML'],
  ['java', 'Java'],
  ['javascript', 'JavaScript'],
  ['json', 'JSON'],
  ['jsx', 'JSX'],
  ['kotlin', 'Kotlin'],
  ['python', 'Python'],
  ['rust', 'Rust'],
  ['sql', 'SQL'],
  ['swift', 'Swift'],
  ['tsx', 'TSX'],
  ['typescript', 'TypeScript'],
  ['yaml', 'YAML'],
];

export const WikiCodeBlock = CodeBlock.extend({
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), prismPlugin()];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.className = 'wiki-code';
      const select = document.createElement('select');
      select.className = 'wiki-code-lang';
      select.contentEditable = 'false';
      select.setAttribute('aria-label', t('wiki.code.language'));
      const lang = (n: PmNode): string => str(n.attrs['language'], '');
      const fill = (current: string): void => {
        select.replaceChildren();
        const known = CODE_LANGUAGES.some(([id]) => id === current);
        for (const [id, name] of known ? CODE_LANGUAGES : [...CODE_LANGUAGES, [current, current] as [string, string]]) {
          const o = document.createElement('option');
          o.value = id;
          o.textContent = id ? name : t('wiki.code.plain');
          select.append(o);
        }
        select.value = current;
      };
      fill(lang(node));
      select.disabled = !editor.isEditable;
      select.addEventListener('change', () => {
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos === undefined) return;
        editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'language', select.value || null));
      });
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.spellcheck = false; // no red squiggles under identifiers and commands
      pre.append(code);
      dom.append(select, pre);
      let current = node;
      return {
        dom,
        contentDOM: code,
        update: (n) => {
          if (n.type !== current.type) return false;
          if (lang(n) !== lang(current)) fill(lang(n));
          select.disabled = !editor.isEditable;
          current = n;
          return true;
        },
        ignoreMutation: (m) => m.target === select || select.contains(m.target),
        stopEvent: (e) => e.target === select,
      };
    };
  },
});

/** Image (schema: @calaba/wiki-doc): an uploaded file of the page; the picker and the view. */
export const WikiImage = ImageNode.extend<{ env: EditorEnv | null }>({
  addOptions: () => ({ env: null }),
  addCommands() {
    return {
      pickImage:
        () =>
        ({ editor }) => {
          const env = this.options.env;
          if (!env?.upload || !editor.isEditable) return false;
          pickImage(editor.view, env);
          return true;
        },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});

/** Mention `@<user id>` (like chat): the label is looked up live; the stored one is a fallback. */
export function wikiMention(env: EditorEnv) {
  return Mention.extend({
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement('span');
        dom.className = 'wiki-mention';
        dom.dataset['type'] = 'mention';
        const paint = (n: PmNode): void => {
          const id = str(n.attrs['id'], '');
          dom.dataset['id'] = id;
          dom.textContent = `@${env.mentions?.label(id) ?? str(n.attrs['label'])}`;
        };
        paint(node);
        return {
          dom,
          update: (n) => {
            if (n.type !== node.type) return false;
            paint(n);
            return true;
          },
        };
      };
    },
  }).configure({
    HTMLAttributes: { class: 'wiki-mention' },
    renderText: ({ node }) => `@${str(node.attrs['label']) || str(node.attrs['id'])}`,
    renderHTML: ({ node, options }) => ['span', mergeAttributes({ 'data-type': 'mention', 'data-id': str(node.attrs['id']) }, options.HTMLAttributes), `@${str(node.attrs['label'], '')}`],
    // Items are MentionCandidates; our own command inserts the node (Mention types them as attrs).
    suggestion: mentionSuggestion(env) as unknown as Partial<SuggestionOptions>,
  });
}

export { HIGHLIGHT_COLORS, type HighlightColor } from '@calaba/wiki-doc/schema';

/** Highlight colours are names (themed by CSS), never raw CSS from the doc. */
export const WikiHighlight = HighlightMark;

const SVG = 'http://www.w3.org/2000/svg';
/** lucide «file-text», drawn per link (light DOM: no React root per link). */
function pageGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M10 9H8', 'M16 13H8', 'M16 17H8']) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * A link to another wiki page (schema: @calaba/wiki-doc, owner 14.10): the page's icon and its
 * live title from the wiki store (a rename follows), resolved lazily by the page GET; deleted / no
 * access → greyed «Недоступная страница» (no title). Light DOM: each link subscribes on its own and
 * repaints only when what it shows changes. Read mode: a click opens the page in the app; edit mode:
 * ⌘/Ctrl-click (a plain click selects the link).
 */
export function wikiPageLink(env: EditorEnv) {
  return WikiPageLinkNode.extend({
    addNodeView() {
      return ({ node, editor }) => {
        const dom = document.createElement('a');
        dom.className = 'wiki-page-link';
        dom.contentEditable = 'false';
        dom.draggable = false;
        const icon = document.createElement('span');
        icon.className = 'wiki-page-link-icon';
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.className = 'wiki-page-link-title';
        dom.append(icon, label);
        let id = str(node.attrs['pageId'], '');
        let shown = '';
        let open = false;
        const paint = (): void => {
          const v = env.pages && id ? env.pages.view(id) : { state: 'unavailable' as const, title: '', icon: '' };
          const key = `${id}|${v.state}|${v.icon}|${v.title}`;
          if (key === shown) return;
          shown = key;
          open = v.state !== 'unavailable';
          dom.dataset['state'] = v.state;
          dom.dataset['pageId'] = id;
          if (open && env.pages) dom.href = env.pages.url(id);
          else dom.removeAttribute('href');
          icon.replaceChildren(v.state === 'page' && v.icon ? document.createTextNode(v.icon) : pageGlyph());
          label.textContent = v.state === 'page' ? v.title || t('wiki.untitled') : v.state === 'loading' ? t('wiki.pageLink.loading') : t('wiki.pageLink.unavailable');
        };
        paint();
        if (id) env.pages?.ensure(id);
        const unsub = env.pages?.subscribe(paint);
        const onClick = (e: MouseEvent): void => {
          // Never the browser's navigation (target, middle click): the app opens the page itself.
          e.preventDefault();
          if (editor.isEditable && !(e.metaKey || e.ctrlKey)) return;
          e.stopPropagation();
          if (open && id) env.pages?.open(id);
        };
        const onAux = (e: MouseEvent): void => e.preventDefault();
        dom.addEventListener('click', onClick);
        dom.addEventListener('auxclick', onAux);
        return {
          dom,
          update: (n) => {
            if (n.type !== node.type) return false;
            const next = str(n.attrs['pageId'], '');
            if (next !== id) {
              id = next;
              if (id) env.pages?.ensure(id);
            }
            paint();
            return true;
          },
          ignoreMutation: () => true,
          destroy: () => {
            unsub?.();
            dom.removeEventListener('click', onClick);
            dom.removeEventListener('auxclick', onAux);
          },
        };
      };
    },
  });
}
