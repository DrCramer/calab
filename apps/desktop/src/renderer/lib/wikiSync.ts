/**
 * Client side of the wiki sync socket (ADR-0096 §4): the generic Yjs provider (lib/ySync.ts) with
 * the wiki's defaults — snapshot meta from the doc's own text, awareness ≤ 10 frames/s.
 */
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { docMeta } from "./wiki/plainText";
import { YSyncProvider, type YSyncDeps, type YSyncStatus } from "./ySync";

export {
  AWARENESS_MIN_GAP_MS,
  AWARENESS_RENEW_MS,
  AWARENESS_TIMEOUT_MS,
  BATCH_MS,
  CLOSE_AUTH,
  CLOSE_FORBIDDEN,
  CLOSE_NOT_FOUND,
  IDLE_SNAPSHOT_MS,
  quietAwareness,
  SNAPSHOT_GAP_MS,
  type Visibility,
} from "./ySync";

export type WikiSyncStatus = YSyncStatus;

/** `meta` defaults to the doc's own text. */
export type WikiSyncDeps = Omit<YSyncDeps, "meta"> & {
  meta?: YSyncDeps["meta"];
};

export class WikiSyncProvider extends YSyncProvider {
  constructor(doc: Y.Doc, awareness: Awareness, deps: WikiSyncDeps) {
    super(doc, awareness, { ...deps, meta: deps.meta ?? (() => docMeta(doc)) });
  }
}

/** The factory the app wires (connection details injected; tests pass a fake socket). */
export function createWikiSync(
  doc: Y.Doc,
  awareness: Awareness,
  deps: WikiSyncDeps,
): WikiSyncProvider {
  return new WikiSyncProvider(doc, awareness, deps);
}
