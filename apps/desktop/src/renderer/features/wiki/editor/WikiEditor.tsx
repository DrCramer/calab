/**
 * The wiki page editor (ADR-0096 §3): Tiptap over a Y.Doc, the page's only heavy component.
 * Loaded lazily (features/wiki/editor/index.ts). The editor instance is created once per doc /
 * awareness / user; callbacks live in a mutable env so new props never rebuild it, and the React
 * tree does not re-render on transactions (`shouldRerenderOnTransaction: false`) — the menus
 * subscribe to exactly what they show.
 */
import { resolveFocusPosition, type Editor, type FocusPosition } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { t } from '../../../i18n';
import { cx } from '../../../components/ui';
import type { BlockDef } from './blocks';
import { createEnv, type EditorEnv } from './env';
import { buildExtensions } from './extensions';
import { BubbleBar, SuggestionMenu, TableBar } from './Menus';
import { offeredBlocks } from './suggestions';
import type { WikiEditorProps } from './types';
import './prose.css';
import './wiki.css';

type EnvProps = Pick<WikiEditorProps, 'onUploadImage' | 'mentionSource' | 'pageSource' | 'imagePath' | 'onError' | 'blocks' | 'highlight' | 'onKey'>;

function assignEnv(env: EditorEnv, p: EnvProps): EditorEnv {
  env.upload = p.onUploadImage ?? null;
  // A new array each render is fine: the set is rebuilt only when the ids change.
  const ids = p.blocks?.join(',') ?? null;
  if (ids !== (env.blocks ? [...env.blocks].join(',') : null)) env.blocks = p.blocks ? new Set(p.blocks) : null;
  env.highlight = p.highlight ?? true;
  env.onKey = p.onKey ?? null;
  env.mentions = p.mentionSource ?? null;
  env.pages = p.pageSource ?? null;
  env.imagePath = p.imagePath ?? ((id) => `/api/files/${id}`);
  env.onError = p.onError ?? ((m) => console.warn(m));
  return env;
}

/**
 * The caret first, the DOM focus after — never Tiptap's `focus` command on an unfocused editor. On
 * iOS that command focuses the DOM synchronously (to raise the keyboard) before dispatching its own
 * transaction: the focus event dispatches one first, a plugin appends to it (the trailing paragraph
 * after a final list or heading, on the editor's first transaction), and the command's transaction,
 * built from the older state, throws «Applying a mismatched transaction» (board #109). Here the
 * selection transaction goes first (taking any such reshaping with it, out of the undo history), and
 * ProseMirror's own focus dispatches nothing stale.
 */
function focusAt(editor: Editor, at: FocusPosition = null): void {
  if (editor.isDestroyed) return;
  const sel = resolveFocusPosition(editor.state.doc, at) ?? editor.state.selection;
  editor.view.dispatch(editor.state.tr.setSelection(sel).scrollIntoView().setMeta('addToHistory', false));
  editor.view.focus();
}

export default function WikiEditor({ doc, content, awareness, editable, me, onUploadImage, mentionSource, pageSource, imagePath, onError, onReady, phone, blocks, highlight, placeholder, label, onKey, compact, className }: WikiEditorProps): ReactNode {
  const props: EnvProps = { onUploadImage, mentionSource, pageSource, imagePath, onError, blocks, highlight, onKey };
  // Filled from the first props (node views read it while the editor is created), then kept fresh
  // without rebuilding the editor: the extensions read it at event time.
  const [env] = useState<EditorEnv>(() => assignEnv(createEnv(), props));
  useLayoutEffect(() => {
    assignEnv(env, props);
  });

  const aw = awareness ?? null;
  const meName = me.name;
  const meColor = me.color;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the name/colour follow via updateUser below; the placeholder is read once
  const extensions = useMemo(() => buildExtensions({ doc, awareness: aw, me: { id: me.id, name: meName, color: meColor }, env, placeholder }), [doc, aw, me.id, env]);
  // A standalone editor's content is its initial value only (later props never reset what is typed).
  const [initial] = useState(() => (doc ? undefined : (content as object | undefined)));

  const editor = useEditor(
    {
      extensions,
      editable,
      ...(initial ? { content: initial } : {}),
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        // The page's keys first (⌘↩ / Esc), unless a popover is open: then Esc / Enter are the popover's.
        handleKeyDown: (_view, event) => (!env.menu.get() && env.onKey ? env.onKey(event) : false),
        attributes: {
          class: 'wiki-prose',
          'aria-label': label ?? t('wiki.editor.label'),
          role: 'textbox',
          'aria-multiline': 'true',
          spellcheck: 'true',
        },
      },
    },
    // Rebuilt only when the collaboration target changes (another page / user).
    [doc, awareness, me.id],
  );

  // Effects guard `isDestroyed`: a Suspense boundary above that re-suspends disconnects the
  // effects, useEditor destroys its instance, and the reconnected effects see the old one first.
  useEffect(() => {
    if (!editor.isDestroyed && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  // The name on my caret follows a rename without rebuilding.
  useEffect(() => {
    if (awareness && !editor.isDestroyed && editor.extensionManager.extensions.some((e) => e.name === 'collaborationCaret')) {
      editor.commands.updateUser({ id: me.id, name: me.name, color: '#8e8e93' }); // carets are coloured by id (extensions.ts)
    }
  }, [editor, awareness, me.id, me.name]);

  // Esc while a `/` `@` `[[` popover is open belongs to the popover. Taken on the window before anyone
  // else (a dialog around the editor closes on Esc in the capture phase, the board closes the task)
  // and handed to the editor's own handlers, which close it.
  useEffect(() => {
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !env.menu.get() || editor.isDestroyed) return;
      if (!(e.target instanceof Node) || !editor.view.dom.contains(e.target)) return;
      e.stopPropagation();
      e.preventDefault();
      editor.view.someProp('handleKeyDown', (f) => f(editor.view, e));
      env.menu.set(null); // the toolbar's «+» list has no suggestion behind it
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [editor, env]);

  const ready = useRef(onReady);
  useEffect(() => {
    ready.current = onReady;
  });
  useEffect(() => {
    if (editor.isDestroyed) return;
    ready.current?.({
      getJSON: () => editor.getJSON(),
      getText: () => editor.getText({ blockSeparator: '\n' }),
      focus: (at) => focusAt(editor, at),
      editor,
      openBlocks: () => {
        if (editor.isDestroyed || !editor.isEditable) return;
        const items = offeredBlocks(env, '', true);
        env.menu.set({
          kind: 'slash',
          items,
          index: -1,
          rect: { left: 0, top: 0, bottom: 0 },
          pick: (b) => {
            env.menu.set(null);
            (b as BlockDef).run(editor.chain().focus()).run();
          },
        });
      },
    });
    return () => ready.current?.(null);
  }, [editor, env]);

  return (
    <div className={cx('wiki-editor', className)} data-editable={editable || undefined} data-phone={phone || undefined} data-compact={compact || undefined}>
      <EditorContent editor={editor} />
      {editable ? (
        <>
          {phone ? null : <BubbleBar editor={editor} env={env} />}
          <TableBar editor={editor} />
          <SuggestionMenu editor={editor} env={env} phone={phone === true} />
        </>
      ) : null}
    </div>
  );
}
