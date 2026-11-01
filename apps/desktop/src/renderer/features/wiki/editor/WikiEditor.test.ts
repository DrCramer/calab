// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { fromMarkdown, toMarkdown, type PmNode } from '../../../lib/wiki/markdown';
import { docPlainText } from '../../../lib/wiki/plainText';
import WikiEditor from './WikiEditor';
import { PhoneToolbar } from './PhoneToolbar';
import { t } from '../../../i18n';

const { own, external } = vi.hoisted(() => ({ own: vi.fn(() => true), external: vi.fn() }));
vi.mock('../../../services/links', () => ({ openOwnLink: own, shareOrigin: () => 'https://app.test' }));
vi.mock('../../../platform', () => ({ platform: { kind: 'web', apiBase: '', directMedia: false, mediaUrl: () => new Promise<string>(() => undefined), apiFetch: vi.fn(), app: { openExternal: external } } }));
import type { Editor } from '@tiptap/core';
import { Slice } from '@tiptap/pm/model';
import type { PageSource, WikiEditorApi, WikiEditorProps } from './types';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout: ProseMirror asks for rects when it scrolls the selection into view.
  const rect = (): DOMRect => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  document.elementFromPoint = () => null;
  Element.prototype.scrollIntoView = () => undefined;
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  own.mockClear(); external.mockClear();
  root = null;
  host = null;
});

function mount(doc: Y.Doc, editable: boolean, extra: Partial<WikiEditorProps> = {}): { api: () => WikiEditorApi; el: HTMLElement; editor: () => Editor } {
  host = document.createElement('div');
  document.body.append(host);
  let api: WikiEditorApi | null = null;
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(WikiEditor, {
        doc,
        editable,
        me: { id: 'u1', name: 'Анна' },
        onReady: (a) => {
          api = a;
        },
        ...extra,
      }),
    );
  });
  return {
    api: () => {
      if (!api) throw new Error('editor not ready');
      return api;
    },
    el: host,
    // Tiptap hangs the editor on its DOM node.
    editor: () => (host?.querySelector('.wiki-prose') as (HTMLElement & { editor?: Editor }) | null)?.editor as Editor,
  };
}

function clipboard(text: string, files: File[] = [], html = ''): ClipboardEvent {
  return {
    clipboardData: { files, types: html ? ['text/plain', 'text/html'] : ['text/plain'], getData: (t: string) => (t === 'text/plain' ? text : t === 'text/html' ? html : '') },
    preventDefault: () => undefined,
  } as unknown as ClipboardEvent;
}

function paste(editor: Editor, ev: ClipboardEvent): boolean {
  let handled = false;
  act(() => {
    handled = !!editor.view.someProp('handlePaste', (f) => f(editor.view, ev, Slice.empty));
  });
  return handled;
}

/** A Y.Doc holding the markdown, in the XML shape y-prosemirror writes (marks = text attributes). */
function seeded(md: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getXmlFragment('default').push((fromMarkdown(md).content ?? []).map(toXml));
  return doc;
}

function toXml(n: PmNode): Y.XmlElement | Y.XmlText {
  if (n.type === 'text') return texts([n]);
  const el = new Y.XmlElement(n.type);
  for (const [k, v] of Object.entries(n.attrs ?? {})) el.setAttribute(k, v as string);
  // Consecutive text nodes are one XmlText with formatted runs (as y-prosemirror writes them).
  const kids: Array<Y.XmlElement | Y.XmlText> = [];
  let run: PmNode[] = [];
  for (const c of n.content ?? []) {
    if (c.type === 'text') run.push(c);
    else {
      if (run.length) kids.push(texts(run));
      run = [];
      kids.push(toXml(c));
    }
  }
  if (run.length) kids.push(texts(run));
  el.insert(0, kids);
  return el;
}

function texts(nodes: PmNode[]): Y.XmlText {
  const t = new Y.XmlText();
  t.applyDelta(
    nodes.map((n) => {
      const attrs: Record<string, unknown> = {};
      for (const m of n.marks ?? []) attrs[m.type] = m.attrs ?? {};
      return Object.keys(attrs).length ? { insert: n.text ?? '', attributes: attrs } : { insert: n.text ?? '' };
    }),
  );
  return t;
}

describe('WikiEditor', () => {
  it('renders a Y.Doc and follows remote changes', () => {
    const doc = seeded('# Plan\n\nFirst **bold** line\n\n- one\n- two');
    const { el, api } = mount(doc, true);
    const prose = el.querySelector('.wiki-prose');
    expect(prose?.getAttribute('contenteditable')).toBe('true');
    expect(prose?.querySelector('h1')?.textContent).toBe('Plan');
    expect(prose?.querySelector('strong')?.textContent).toBe('bold');
    expect(prose?.querySelectorAll('li')).toHaveLength(2);
    // A co-author's edit arrives through Yjs.
    act(() => {
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText('from peer')]);
      doc.getXmlFragment('default').push([p]);
    });
    expect(api().getText()).toContain('from peer');
    expect(docPlainText(doc)).toContain('from peer');
    expect(toMarkdown(api().getJSON() as PmNode)).toBe('# Plan\n\nFirst **bold** line\n\n- one\n- two\n\nfrom peer\n');
  });

  it('is read-only with editable=false', () => {
    const doc = seeded('text');
    const { el } = mount(doc, false);
    expect(el.querySelector('.wiki-prose')?.getAttribute('contenteditable')).toBe('false');
    expect(el.querySelector('[role="toolbar"]')).toBeNull();
  });

  it('folds a toggle locally without touching the doc', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    const toggle = toXml({ type: 'toggle', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Summary' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] });
    frag.push([toggle]);
    const { el } = mount(doc, true);
    const node = el.querySelector<HTMLElement>('.wiki-toggle');
    const before = Y.encodeStateAsUpdate(doc);
    expect(node?.dataset['open']).toBe('true');
    act(() => node?.querySelector<HTMLButtonElement>('.wiki-toggle-btn')?.click());
    expect(node?.dataset['open']).toBe('false');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('keeps only file ids for images (no src, no data: URLs)', () => {
    const doc = new Y.Doc();
    doc.getXmlFragment('default').push([toXml({ type: 'image', attrs: { fileId: 'f-1', width: 40, height: 20, alt: 'x' } })]);
    const { api } = mount(doc, true);
    const json = JSON.stringify(api().getJSON());
    expect(json).toContain('"fileId":"f-1"');
    expect(json).not.toContain('data:');
  });

  it('opens the / menu, filters it and turns the line into the picked block', async () => {
    const doc = seeded('');
    const { editor } = mount(doc, true);
    await act(async () => {
      editor().chain().focus('end').insertContent('/заг').run();
      await new Promise((r) => setTimeout(r, 0));
    });
    const rows = [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((r) => r.textContent);
    expect(rows).toEqual(['Заголовок 1#', 'Заголовок 2##', 'Заголовок 3###']);
    act(() => {
      document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')[1]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(editor().getJSON().content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    expect(editor().getText().trim()).toBe(''); // the "/заг" query is gone
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('converts pasted markdown text, leaves HTML pastes to ProseMirror', () => {
    const { editor } = mount(seeded(''), true);
    act(() => {
      editor().commands.focus('end');
    });
    expect(paste(editor(), clipboard('# Title\n\n- [ ] task\n- [x] done'))).toBe(true);
    const content = editor().getJSON().content;
    expect(content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(content.some((n) => n.type === 'taskList')).toBe(true);
    expect(paste(editor(), clipboard('# Title', [], '<h1>Title</h1>'))).toBe(false);
  });

  describe('page links (owner 14.10)', () => {
    const P1 = '0190a0b0-0000-7000-80c1-000000000001';
    const P2 = '0190a0b0-0000-7000-80c1-000000000002';
    const GONE = '0190a0b0-0000-7000-80c1-00000000000f';
    function source(): PageSource & { opened: string[]; titles: Record<string, string>; fire: () => void } {
      const subs = new Set<() => void>();
      const titles: Record<string, string> = { [P1]: 'Roadmap', [P2]: 'Release notes' };
      const opened: string[] = [];
      return {
        opened,
        titles,
        fire: () => subs.forEach((f) => f()),
        search: (q) =>
          Object.entries(titles)
            .filter(([, title]) => title.toLowerCase().includes(q.toLowerCase()))
            .map(([id, title]) => ({ id, title, icon: '' })),
        remote: () => Promise.resolve([]),
        view: (id) => (titles[id] !== undefined ? { state: 'page', title: titles[id] ?? '', icon: '' } : { state: 'unavailable', title: '', icon: '' }),
        subscribe: (cb) => {
          subs.add(cb);
          return () => subs.delete(cb);
        },
        ensure: () => undefined,
        open: (id) => opened.push(id),
        idOf: (href) => /^https:\/\/app\.test\/wiki\/([0-9a-f-]{36})$/.exec(href)?.[1] ?? null,
        url: (id) => `https://app.test/wiki/${id}`,
      };
    }

    it('[[ opens the page picker and inserts a live-titled page link', async () => {
      const pages = source();
      const { editor, el } = mount(seeded(''), true, { pageSource: pages });
      await act(async () => {
        editor().chain().focus('end').insertContent('see [[road').run();
        await new Promise((r) => setTimeout(r, 0));
      });
      const rows = [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((r) => r.textContent);
      expect(rows).toEqual(['Roadmap']);
      act(() => {
        document.querySelector<HTMLElement>('[role="listbox"] [role="option"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(editor().getJSON().content[0]?.content).toEqual([
        { type: 'text', text: 'see ' },
        { type: 'wikiPageLink', attrs: { pageId: P1 } },
        { type: 'text', text: ' ' },
      ]);
      const link = el.querySelector<HTMLAnchorElement>('a.wiki-page-link');
      expect(link?.textContent).toBe('Roadmap');
      // A rename follows live; edit mode: a plain click does not navigate.
      act(() => {
        pages.titles[P1] = 'Roadmap 2027';
        pages.fire();
      });
      expect(link?.textContent).toBe('Roadmap 2027');
      act(() => link?.click());
      expect(pages.opened).toEqual([]);
      act(() => {
        link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
      });
      expect(pages.opened).toEqual([P1]);
    });

    it('read mode: a click opens the page; an unavailable page shows no title and does not open', () => {
      const pages = source();
      const doc = seeded(`[a](https://app.test/wiki/${P2}) and [b](https://app.test/wiki/${GONE})`);
      const { el } = mount(doc, false, { pageSource: pages });
      const [ok, gone] = [...el.querySelectorAll<HTMLAnchorElement>('a.wiki-page-link')];
      expect(ok?.textContent).toBe('Release notes');
      expect(gone?.dataset['state']).toBe('unavailable');
      expect(gone?.textContent).toBe('Недоступная страница');
      act(() => ok?.click());
      act(() => gone?.click());
      expect(pages.opened).toEqual([P2]);
    });

    it('a pasted page address of this server becomes a page link', () => {
      const pages = source();
      const { editor } = mount(seeded(''), true, { pageSource: pages });
      act(() => {
        editor().commands.focus('end');
      });
      expect(paste(editor(), clipboard(`https://app.test/wiki/${P2}`))).toBe(true);
      expect(JSON.stringify(editor().getJSON())).toContain(`"type":"wikiPageLink","attrs":{"pageId":"${P2}"}`);
      // Another site's /wiki/ address is left to the link mark.
      expect(paste(editor(), clipboard(`https://elsewhere.test/wiki/${P2}`))).toBe(false);
    });
  });

  it('uploads a pasted image behind a local placeholder and stores only the file id', async () => {
    let resolve: (v: { fileId: string; width: number; height: number }) => void = () => undefined;
    const upload = vi.fn(() => new Promise<{ fileId: string; width: number; height: number }>((r) => (resolve = r)));
    const doc = seeded('text');
    const { editor, el } = mount(doc, true, { onUploadImage: upload });
    URL.createObjectURL = () => 'blob:local';
    URL.revokeObjectURL = () => undefined;
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    act(() => {
      editor().commands.focus('end');
    });
    expect(paste(editor(), clipboard('', [file]))).toBe(true);
    expect(upload).toHaveBeenCalledWith(file);
    expect(el.querySelector('.wiki-upload')).not.toBeNull();
    expect(JSON.stringify(editor().getJSON())).not.toContain('image');
    await act(async () => {
      resolve({ fileId: 'file-9', width: 640, height: 480 });
      await Promise.resolve();
    });
    expect(el.querySelector('.wiki-upload')).toBeNull();
    const json = JSON.stringify(editor().getJSON());
    expect(json).toContain('"fileId":"file-9"');
    expect(json).not.toContain('blob:');
    expect(docPlainText(doc)).toBe('text');
  });

  it('standalone (no Yjs): edits its content with local undo, offers only its blocks, lets the page take keys', () => {
    const keys: string[] = [];
    const onKey = (e: KeyboardEvent): boolean => {
      keys.push(e.key);
      return e.key === 'Escape';
    };
    const { api, editor } = mount(null as unknown as Y.Doc, true, { doc: null, content: fromMarkdown('- a'), blocks: ['text', 'bullet'], highlight: false, onKey });
    expect(toMarkdown(editor().getJSON() as PmNode, { lite: true })).toBe('- a');
    act(() => {
      editor().commands.focus('end');
      editor().commands.insertContent('b');
    });
    expect(toMarkdown(editor().getJSON() as PmNode, { lite: true })).toBe('- ab');
    act(() => {
      editor().commands.undo();
    });
    expect(toMarkdown(editor().getJSON() as PmNode, { lite: true })).toBe('- a');
    const key = (k: string): boolean => !!editor().view.someProp('handleKeyDown', (f) => f(editor().view, new KeyboardEvent('keydown', { key: k })));
    expect(key('Escape')).toBe(true);
    expect(key('x')).toBe(false);
    expect(keys).toEqual(['Escape', 'x']);
    act(() => api().openBlocks());
    expect([...document.querySelectorAll('[role=option]')].map((o) => o.textContent)).toHaveLength(2);
    // While a popover is open Esc is its own: the page is not asked; the window-level catch closes it.
    key('Escape');
    expect(keys).toEqual(['Escape', 'x']);
    act(() => {
      editor().view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelectorAll('[role=option]')).toHaveLength(0);
  });
  // Board #109: iOS focuses the DOM inside Tiptap's focus command, before the command's transaction is
  // dispatched; the focus event's own transaction ran first and (on a doc ending in a list) the
  // trailing-node plugin reshaped the doc under it — `Applying a mismatched transaction`.
  it('opens focused at the end on iOS when the text ends in a list (no mismatched transaction)', () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('iPhone');
    try {
      let api: WikiEditorApi | null = null;
      const { editor } = mount(null as unknown as Y.Doc, true, {
        doc: null,
        content: fromMarkdown('# Заголовок\n\nТекст со **жирным** и [ссылкой](https://calab.io)\n\n- первый\n- второй'),
        blocks: ['text', 'bullet'],
        onReady: (a) => {
          api = a;
          a?.focus('end');
        },
      });
      expect(api).not.toBeNull();
      expect(editor().view.hasFocus()).toBe(true);
      // The caret at the end of the text — in the last list item, not the trailing paragraph.
      const { $from } = editor().state.selection;
      expect($from.parent.textContent).toBe('второй');
      expect($from.parentOffset).toBe('второй'.length);
      // The initial text is unchanged and undo has nothing to take back.
      expect(toMarkdown(editor().getJSON() as PmNode, { lite: true })).toContain('- второй');
      expect(editor().can().undo()).toBe(false);
    } finally {
      platform.mockRestore();
    }
  });
});


describe('content link activation in the shared editor', () => {
  it.each(['/t/DEV-1', '/b/0190a0b0-0000-7000-80c1-000000000001', '/disk/0190a0b0-0000-7000-80c1-000000000001', '/canvas/0190a0b0-0000-7000-80c1-000000000001'])('read-only %s routes inside the app without a new window', (path) => {
    const { el } = mount(seeded(`[Open](https://app.test${path})`), false);
    const popup = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      act(() => el.querySelector<HTMLAnchorElement>('.wiki-prose a')?.click());
      expect(own).toHaveBeenCalledWith(`https://app.test${path}`);
      expect(popup).not.toHaveBeenCalled(); expect(external).not.toHaveBeenCalled();
    } finally { popup.mockRestore(); }
  });
  it('editing leaves caret clicks alone, modifier activation routes once', () => {
    const { el } = mount(seeded('[Open](https://app.test/t/DEV-1)'), true);
    const a = el.querySelector<HTMLAnchorElement>('.wiki-prose a');
    act(() => a?.click()); expect(own).not.toHaveBeenCalled();
    act(() => { a?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })); });
    expect(own).toHaveBeenCalledTimes(1); expect(external).not.toHaveBeenCalled();
  });
});


describe('editor open-link buttons', () => {
  it('phone toolbar opens an internal route without a popup', async () => {
    const { editor } = mount(seeded('[Open](https://app.test/t/DEV-1)'), true, { phone: true });
    const slot = document.createElement('div'); document.body.append(slot);
    const toolbar = createRoot(slot);
    const popup = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      await act(async () => {
        editor().commands.setTextSelection(2);
        editor().commands.focus();
        await new Promise((r) => setTimeout(r, 30));
        toolbar.render(createElement(PhoneToolbar, { editor: editor(), onBlocks: () => undefined }));
      });
      const button = slot.querySelector<HTMLButtonElement>('[data-testid="wiki-tool-open-link"]');
      expect(button).not.toBeNull(); act(() => button?.click());
      expect(own).toHaveBeenCalledWith('https://app.test/t/DEV-1'); expect(popup).not.toHaveBeenCalled();
    } finally { act(() => toolbar.unmount()); slot.remove(); popup.mockRestore(); }
  });
  it('bubble link field opens an internal route without a popup', async () => {
    const { editor } = mount(seeded('[Open](https://app.test/t/DEV-1)'), true);
    const popup = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      await act(async () => {
        editor().commands.setTextSelection({ from: 1, to: 5 });
        editor().commands.focus();
        await new Promise((r) => setTimeout(r, 30));
      });
      const link = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === t('wiki.link'));
      expect(link).toBeDefined(); act(() => link?.click());
      const open = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === t('wiki.link.open'));
      expect(open).toBeDefined(); act(() => open?.click());
      expect(own).toHaveBeenCalledWith('https://app.test/t/DEV-1'); expect(popup).not.toHaveBeenCalled();
    } finally { popup.mockRestore(); }
  });
});


it('routes a root-relative link mark already stored in the rich editor', () => {
  const { editor, el } = mount(seeded('Open'), true);
  act(() => {
    editor().commands.setTextSelection({ from: 1, to: 5 });
    editor().commands.setLink({ href: '/t/DEV-1' });
  });
  const a = el.querySelector<HTMLAnchorElement>('.wiki-prose a');
  expect(a?.getAttribute('href')).toBe('/t/DEV-1');
  act(() => { a?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })); });
  expect(own).toHaveBeenCalledWith('https://app.test/t/DEV-1');
  expect(external).not.toHaveBeenCalled();
});
