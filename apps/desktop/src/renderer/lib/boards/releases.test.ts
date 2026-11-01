import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { TaskField, TaskOp, TaskReleaseSchema, TaskSchema, type Task } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { matchCond, type MatchCtx } from './filter';
import { latestRelease, pipelineUrl, releaseLabel, releasesOf } from './releases';

const rel = (id: string, name: string, env: string, ms: number) => create(TaskReleaseSchema, { releaseId: id, name, environment: env, createdAt: timestampFromMs(ms) });
const task = (id: string, ...releases: ReturnType<typeof rel>[]): Task => create(TaskSchema, { id, releases });

describe('releases (board task #101)', () => {
  const a = task('a', rel('r2', '1288', 'stage', 2000), rel('r1', '4929cf3', 'prod', 1000));
  const b = task('b', rel('r1', '4929cf3', 'prod', 1500));
  const none = task('c');

  it('groups a task under its newest release', () => {
    expect(latestRelease(a)?.releaseId).toBe('r2');
    expect(latestRelease(none)).toBeUndefined();
    expect(releaseLabel(rel('x', '4929cf3', 'prod', 0))).toBe('prod · 4929cf3');
  });

  it('lists distinct releases, newest first', () => {
    expect(releasesOf([a, b, none]).map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(releasesOf([b, a], true).map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(releasesOf([b]).at(0)?.at).toBe(1500);
  });

  it('opens only http(s) pipelines', () => {
    expect(pipelineUrl('https://ci.example/p/1')).toBe('https://ci.example/p/1');
    expect(pipelineUrl('javascript:alert(1)')).toBe('');
    expect(pipelineUrl('')).toBe('');
  });

  it('matches the RELEASE filter locally', () => {
    const ctx = { me: 'me', statuses: {}, today: '2026-10-29' } as unknown as MatchCtx;
    expect(matchCond(a, { field: TaskField.RELEASE, op: TaskOp.IS, values: ['r1'] }, ctx)).toBe(true);
    expect(matchCond(none, { field: TaskField.RELEASE, op: TaskOp.IS, values: ['r1'] }, ctx)).toBe(false);
    expect(matchCond(none, { field: TaskField.RELEASE, op: TaskOp.EMPTY, values: [] }, ctx)).toBe(true);
    expect(matchCond(b, { field: TaskField.RELEASE, op: TaskOp.IS_NOT, values: ['r1'] }, ctx)).toBe(false);
  });
});
