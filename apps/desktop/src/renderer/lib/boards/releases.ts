import { timestampMs } from '@bufbuild/protobuf/wkt';
import type { Task, TaskRelease } from '@calaba/protocol';

/**
 * Releases of a board (board task #101, ADR-0060 §4): CI posts a deploy, the tasks that went
 * out carry `Task.releases` — one per environment, newest first. The client groups and filters
 * by them from the tasks it has (no list request): the filter offers the releases its tasks
 * know. Pure.
 */

export interface ReleaseItem {
  id: string;
  name: string;
  environment: string;
  url: string;
  /** When the first of the tasks entered it (ms; ordering only). */
  at: number;
}

const at = (r: TaskRelease): number => (r.createdAt ? timestampMs(r.createdAt) : 0);

/** The release a task is grouped under: the newest one, any environment. */
export function latestRelease(t: Pick<Task, 'releases'>): TaskRelease | undefined {
  let best: TaskRelease | undefined;
  for (const r of t.releases) if (!best || at(r) > at(best)) best = r;
  return best;
}

/** «prod · 4929cf3». */
export const releaseLabel = (r: Pick<TaskRelease, 'name' | 'environment'>): string => (r.environment ? `${r.environment} · ${r.name}` : r.name);

/** The distinct releases of `tasks`, newest first (`latestOnly`: only those a task is grouped under). */
export function releasesOf(tasks: Iterable<Pick<Task, 'releases'>>, latestOnly = false): ReleaseItem[] {
  const by = new Map<string, ReleaseItem>();
  for (const t of tasks) {
    const list = latestOnly ? [latestRelease(t)].filter((r): r is TaskRelease => !!r) : t.releases;
    for (const r of list) {
      const cur = by.get(r.releaseId);
      const when = at(r);
      if (!cur) by.set(r.releaseId, { id: r.releaseId, name: r.name, environment: r.environment, url: r.url, at: when });
      else if (when < cur.at) cur.at = when;
    }
  }
  return [...by.values()].sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
}

/** An http(s) pipeline address (anything else is not a link). */
export function pipelineUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}
