import { TaskPriority, type Task } from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';

/** «Мои задачи» ordering and filter (ADR-0042 §5): newest first by default, pure so it is unit-tested. */
export const MY_SORTS = ['created', 'updated', 'due', 'priority'] as const;
export type MySort = (typeof MY_SORTS)[number];
export const isMySort = (v: unknown): v is MySort => typeof v === 'string' && (MY_SORTS as readonly string[]).includes(v);

export type MyDue = 'any' | 'overdue' | 'dated';
export const MY_DUES: readonly MyDue[] = ['any', 'overdue', 'dated'];
export const isMyDue = (v: unknown): v is MyDue => typeof v === 'string' && (MY_DUES as readonly string[]).includes(v);

export interface MyFilter {
  /** TaskPriority values; empty = any. */
  priorities: readonly number[];
  due: MyDue;
  /** Board ids; empty = every board. */
  boards: readonly string[];
}

export const EMPTY_MY_FILTER: MyFilter = { priorities: [], due: 'any', boards: [] };

/** Number of applied conditions (the header badge). */
export const myFilterCount = (f: MyFilter): number => (f.priorities.length ? 1 : 0) + (f.due !== 'any' ? 1 : 0) + (f.boards.length ? 1 : 0);

/** A stored filter of an older / foreign build, sanitised. */
export function migrateMyFilter(v: unknown): MyFilter {
  if (!v || typeof v !== 'object') return EMPTY_MY_FILTER;
  const o = v as Partial<Record<keyof MyFilter, unknown>>;
  return {
    priorities: Array.isArray(o.priorities) ? o.priorities.filter((x): x is number => typeof x === 'number') : [],
    due: isMyDue(o.due) ? o.due : 'any',
    boards: Array.isArray(o.boards) ? o.boards.filter((x): x is string => typeof x === 'string') : [],
  };
}

const PRIORITY_RANK: Record<number, number> = { [TaskPriority.URGENT]: 0, [TaskPriority.HIGH]: 1, [TaskPriority.MEDIUM]: 2, [TaskPriority.LOW]: 3, [TaskPriority.NONE]: 4 };
const ms = (x: Task['createdAt']): number => (x ? timestampMs(x) : 0);

/** Whether `x` passes the filter; `done` = its status is completed / canceled, `today` = local day key. */
export function matchMine(x: Pick<Task, 'priority' | 'dueOn' | 'boardId'>, f: MyFilter, today: string, done: boolean): boolean {
  if (f.priorities.length && !f.priorities.includes(x.priority)) return false;
  if (f.boards.length && !f.boards.includes(x.boardId)) return false;
  if (f.due === 'dated' && !x.dueOn) return false;
  if (f.due === 'overdue' && !(x.dueOn && !done && x.dueOn < today)) return false;
  return true;
}

/** Sorted copy: «created» / «updated» newest first, «due» soonest first (undated last), «priority» urgent first; ties: newest first. */
export function sortMine(list: readonly Task[], sort: MySort): Task[] {
  const created = (a: Task, b: Task): number => ms(b.createdAt) - ms(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const out = [...list];
  switch (sort) {
    case 'updated':
      return out.sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt) || created(a, b));
    case 'due':
      return out.sort((a, b) => (a.dueOn || '9999').localeCompare(b.dueOn || '9999') || created(a, b));
    case 'priority':
      return out.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || created(a, b));
    default:
      return out.sort(created);
  }
}
