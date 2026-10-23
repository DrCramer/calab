import { Search } from 'lucide-react';
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Input, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import type { Completion } from '../../lib/boards/completion';
import { log } from '../../lib/log';
import { ALL_TASKS_LIMIT, searchAllTasks } from '../../services/boards';
import { useBoards, workspaceBoards } from '../../stores/boards';
import { CompletionSwitch } from './CompletionSwitch';
import { ListRow } from './ListView';

/** Typing pause before a request: one query per word, not per key. */
const DEBOUNCE_MS = 250;

type Found = { q: string; state: Completion; ids: string[] } | null;

/**
 * «Мои задачи → Все задачи» (CBF-35): one field over every board of the workspace — title, key,
 * description (GET …/tasks/search, the server keeps only the boards the caller sees) — with
 * «Незавершённые · Завершённые · Все». Rows: key, title, board, status; a click opens the task.
 */
export function AllTasks({ workspaceId, onOpen }: { workspaceId: string; onOpen: (id: string, e: MouseEvent) => void }): ReactNode {
  const [q, setQ] = useState('');
  const [state, setState] = useState<Completion>('open');
  const [found, setFound] = useState<Found>(null);
  const query = q.trim();
  useEffect(() => {
    if (!query) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      searchAllTasks(workspaceId, query, state, ctl.signal).then(
        (ids) => setFound({ q: query, state, ids }),
        (e: unknown) => {
          if (ctl.signal.aborted) return;
          log.warn('all tasks search failed', e);
          setFound({ q: query, state, ids: [] });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [workspaceId, query, state]);
  const loading = !!query && (found?.q !== query || found.state !== state);
  const ids = query && found ? found.ids : EMPTY;
  // «boardId:taskId» per row (primitives); a task archived / gone since the answer drops out.
  const rows = useBoards(useShallow((s) => ids.flatMap((id) => (s.tasks[id] && !s.tasks[id].archivedAt ? [`${s.tasks[id].boardId}:${id}`] : []))));
  const names = useBoards(useShallow((s) => workspaceBoards(s.boards, workspaceId).map((b) => `${b.id}\u0000${b.emoji || '📋'} ${b.name}`)));
  const nameOf = useMemo(() => new Map(names.map((x) => x.split('\u0000') as [string, string])), [names]);
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 px-3" data-testid="all-tasks-bar">
        <div className="min-w-0 flex-1">
          <Input
            icon={<Search />}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={200}
            autoFocus
            placeholder={t('boards.all.placeholder')}
            aria-label={t('boards.allTasks')}
            data-testid="all-tasks-search"
          />
        </div>
        <CompletionSwitch value={state} onChange={setState} />
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto" data-testid="all-tasks-view" aria-busy={loading || undefined}>
        {!query ? (
          <p className="p-10 text-center text-body text-muted">{t('boards.all.hint')}</p>
        ) : loading && !rows.length ? (
          <div className="grid h-32 place-items-center">
            <Spinner />
          </div>
        ) : !rows.length ? (
          <p className="p-10 text-center text-body text-muted" data-testid="all-tasks-empty">
            {t('boards.all.empty')}
          </p>
        ) : (
          <>
            {rows.map((r) => {
              const [board = '', id = ''] = r.split(':');
              return <ListRow key={id} id={id} boardId={board} boardLabel={nameOf.get(board) ?? ''} workspaceId={workspaceId} onClick={onOpen} selecting={false} />;
            })}
            {ids.length >= ALL_TASKS_LIMIT ? <p className="px-4 py-3 text-caption text-muted">{t('boards.all.more', { n: ALL_TASKS_LIMIT })}</p> : null}
          </>
        )}
      </div>
    </>
  );
}

const EMPTY: string[] = [];
