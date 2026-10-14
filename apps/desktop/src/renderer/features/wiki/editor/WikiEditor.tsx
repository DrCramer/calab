/**
 * The wiki page editor (ADR-0096 §3): Tiptap over a Y.Doc, the page's only heavy component.
 * Loaded lazily (features/wiki/editor/index.ts). The editor instance is created once per doc /
 * awareness / user; callbacks live in a mutable env so new props never rebuild it, and the React
 * tree does not re-render on transactions (`shouldRerenderOnTransaction: false`) — the menus
 * subscribe to exactly what they show.
 */
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { t } from '../../../i18n';
import { cx } from '../../../components/ui';
import { createEnv, type EditorEnv } from './env';
import { buildExtensions } from './extensions';
import { BubbleBar, SuggestionMenu, TableBar } from './Menus';
import type { WikiEditorProps } from './types';
import './wiki.css';

function assignEnv(env: EditorEnv, p: Pick<WikiEditorProps, 'onUploadImage' | 'mentionSource' | 'imagePath' | 'onError'>): EditorEnv {
  env.upload = p.onUploadImage ?? null;
  env.mentions = p.mentionSource ?? null;
  env.imagePath = p.imagePath ?? ((id) => `/api/files/${id}`);
  env.onError = p.onError ?? ((m) => console.warn(m));
  return env;
}

export default function WikiEditor({ doc, awareness, editable, me, onUploadImage, mentionSource, imagePath, onError, onReady, className }: WikiEditorProps): ReactNode {
  const props = { onUploadImage, mentionSource, imagePath, onError };
  // Filled from the first props (node views read it while the editor is created), then kept fresh
  // without rebuilding the editor: the extensions read it at event time.
  const [env] = useState<EditorEnv>(() => assignEnv(createEnv(), props));
  useLayoutEffect(() => {
    assignEnv(env, props);
  });

  const aw = awareness ?? null;
  const meName = me.name;
  const meColor = me.color;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the name/colour follow via updateUser below
  const extensions = useMemo(() => buildExtensions({ doc, awareness: aw, me: { id: me.id, name: meName, color: meColor }, env }), [doc, aw, me.id, env]);

  const editor = useEditor(
    {
      extensions,
      editable,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class: 'wiki-prose',
          'aria-label': t('wiki.editor.label'),
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
      editor.commands.updateUser({ id: me.id, name: me.name, color: me.color ?? '' });
    }
  }, [editor, awareness, me.id, me.name, me.color]);

  const ready = useRef(onReady);
  useEffect(() => {
    ready.current = onReady;
  });
  useEffect(() => {
    if (editor.isDestroyed) return;
    ready.current?.({
      getJSON: () => editor.getJSON(),
      getText: () => editor.getText({ blockSeparator: '\n' }),
      focus: () => editor.commands.focus(),
    });
    return () => ready.current?.(null);
  }, [editor]);

  return (
    <div className={cx('wiki-editor', className)} data-editable={editable || undefined}>
      <EditorContent editor={editor} />
      {editable ? (
        <>
          <BubbleBar editor={editor} env={env} />
          <TableBar editor={editor} />
          <SuggestionMenu env={env} />
        </>
      ) : null}
    </div>
  );
}
