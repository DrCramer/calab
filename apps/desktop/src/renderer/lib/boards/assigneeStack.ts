/**
 * The assignee circles on a board card / list row (#92): at most `MAX_CIRCLES` of equal size; when
 * there are more people, the last circle is «+N» (it counts the people it hides). Order = who was
 * assigned earlier first (ties keep the server order; an unknown time goes last). Pure.
 */
export const MAX_CIRCLES = 3;

export interface StackAssignee {
  userId: string;
  /** Assigned at, ms; 0 when unknown. */
  atMs: number;
}

export interface AssigneeStackLayout {
  /** People drawn as avatars, in order. */
  shown: StackAssignee[];
  /** People behind the «+N» circle; 0 = no such circle. */
  more: number;
}

export function sortByAssigned<T extends StackAssignee>(list: readonly T[]): T[] {
  const key = (a: T): number => a.atMs || Number.POSITIVE_INFINITY;
  return list
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const kx = key(x.a);
      const ky = key(y.a);
      return kx === ky ? x.i - y.i : kx < ky ? -1 : 1;
    })
    .map((x) => x.a);
}

export function stackLayout(list: readonly StackAssignee[]): AssigneeStackLayout {
  const sorted = sortByAssigned(list);
  if (sorted.length <= MAX_CIRCLES) return { shown: sorted, more: 0 };
  return { shown: sorted.slice(0, MAX_CIRCLES - 1), more: sorted.length - (MAX_CIRCLES - 1) };
}
