import type { Editor } from '@tiptap/core';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { MentionCandidate } from '../../../lib/mentions';

/** People the `@` popover offers and how a mention reads (the page's workspace members). */
export interface MentionSource {
  /** Best candidates for the typed query (lib/mentions `filterCandidates`). */
  search(query: string): MentionCandidate[];
  /** The current, nickname-aware name of a user (without «@»); undefined = unknown here. */
  label(id: string): string | undefined;
}

/** A page offered by the `[[` picker. */
export interface PageCandidate {
  id: string;
  title: string;
  icon: string;
}

/** What a page link shows now: the page, a placeholder while it resolves, or «unavailable» (deleted / no access — no title). */
export interface PageLinkView {
  state: 'page' | 'loading' | 'unavailable';
  title: string;
  icon: string;
}

/**
 * Links to other wiki pages (owner 14.10): the `[[` picker's pages, a link's live title, opening a
 * page in the app. Absent (the public page) → links render as unavailable and do not open.
 */
export interface PageSource {
  /** Loaded pages of the workspace matching the query (instant). */
  search(query: string): PageCandidate[];
  /** The server search (`type=wiki`) for pages not loaded yet. */
  remote(query: string, signal: AbortSignal): Promise<PageCandidate[]>;
  view(id: string): PageLinkView;
  /** Called on any change that may alter a view; returns the unsubscribe. */
  subscribe(cb: () => void): () => void;
  /** Starts resolving a page not known yet (once per id). */
  ensure(id: string): void;
  open(id: string): void;
  /** The page id of an address of this server (a paste, a link click); null for any other URL. */
  idOf(href: string): string | null;
  url(id: string): string;
}

export interface UploadedImage {
  fileId: string;
  /** Unused by the doc (images render through the file URL helper); kept for the caller's cache. */
  url?: string;
  width: number;
  height: number;
}

export interface WikiEditorUser {
  id: string;
  name: string;
  /** Identity colour; cursors are drawn from the user id (Avatar palette) so peers agree. */
  color?: string;
}

export interface WikiEditorProps {
  doc: Y.Doc;
  /** Collaboration cursors; omit for a standalone doc (tests, public page). */
  awareness?: Awareness | null;
  editable: boolean;
  me: WikiEditorUser;
  /** Uploads a pasted / dropped / picked image into the page (`POST /api/wiki/pages/{id}/files`). */
  onUploadImage?: (file: File) => Promise<UploadedImage>;
  mentionSource?: MentionSource | null;
  /** Wiki page links: the `[[` picker and the links' titles (omit: the public page). */
  pageSource?: PageSource | null;
  /** API path of an image file (default `/api/files/{id}`; the public page passes its own route). */
  imagePath?: (fileId: string) => string;
  /** Upload failed (toast); default: console. */
  onError?: (message: string) => void;
  /** Receives the editor API once it exists (export, focus); null on unmount. */
  onReady?: (api: WikiEditorApi | null) => void;
  /**
   * The phone layout (ADR-0096 §7): the `/` block menu is a card in the middle of the screen, no
   * selection bubble (the page has its own toolbar above the keyboard), collaborators' carets are
   * not drawn (the page shows a counter instead).
   */
  phone?: boolean;
  className?: string;
}

/** What the page around the editor may call (export, focus). */
export interface WikiEditorApi {
  /** ProseMirror JSON of the document (for `lib/wiki/markdown` export). */
  getJSON(): unknown;
  /** Plain text (one line per block). */
  getText(): string;
  focus(): void;
  /** The Tiptap editor (the phone toolbar runs its commands; types only outside the chunk). */
  editor: Editor;
  /** Opens the block menu (the toolbar's «+»). */
  openBlocks(): void;
}
