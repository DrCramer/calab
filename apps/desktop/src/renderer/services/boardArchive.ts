import type { Task } from '@calaba/protocol';
import { t } from '../i18n';
import { archiveFilter } from '../lib/boards/archive';
import { log } from '../lib/log';
import { useBoardArchive } from '../stores/boardArchive';
import { useToasts } from '../stores/toasts';
import { boardsApi } from './boardsApi';
import { restoreTask } from './boards';

/** Archive pages: 50 rows (the server caps at 500; the view scrolls, it does not need a screenful of thousands). */
export const ARCHIVE_PAGE = 50;

let seq = 0;

/** (Re)start the archive of a board with a search text: the first page. A stale answer is dropped. */
export async function openArchiveList(boardId: string, query = ''): Promise<void> {
  const mine = ++seq;
  useBoardArchive.getState().reset(boardId, query);
  try {
    const r = await boardsApi.tasks.list(boardId, { archived: true, filter: archiveFilter(query), limit: ARCHIVE_PAGE });
    if (mine === seq) useBoardArchive.getState().setPage(r.tasks, r.nextCursor, false);
  } catch (e) {
    log.warn('archive failed', e);
    if (mine === seq) useBoardArchive.getState().setError();
  }
}

/** The next page of the archive being shown (no-op on the last page or while one is in flight). */
export async function loadMoreArchive(): Promise<void> {
  const s = useBoardArchive.getState();
  if (!s.cursor || s.more || s.load !== 'ready') return;
  const mine = seq;
  s.setLoading(true);
  try {
    const r = await boardsApi.tasks.list(s.boardId, { archived: true, filter: archiveFilter(s.query), cursor: s.cursor, limit: ARCHIVE_PAGE });
    if (mine === seq) useBoardArchive.getState().setPage(r.tasks, r.nextCursor, true);
  } catch (e) {
    log.warn('archive page failed', e);
    if (mine === seq) useBoardArchive.getState().setError();
  }
}

/** «Восстановить» in the archive: the task returns to the board (the main store) and leaves the list. */
export async function restoreFromArchive(task: Pick<Task, 'id' | 'key'>): Promise<void> {
  if (!(await restoreTask(task.id))) return;
  useBoardArchive.getState().drop(task.id);
  useToasts.getState().push('info', t('boards.restoredToast', { key: task.key }));
}
