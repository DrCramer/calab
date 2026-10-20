import { GitProvider, TaskGitLinkKind, TaskGitLinkState, type TaskGitLink } from '@calaba/protocol';
import type { MessageKey } from '../../i18n';

/**
 * Git links of a task on the client (ADR-0060 §4): how a link row looks — the kind glyph and its
 * tone (branch; PR open green / merged purple / closed grey; commit), the reference «repo#123» /
 * the branch / the short SHA — and the providers of the board's Git tab. Pure.
 */
export type GitGlyph = 'branch' | 'pr-open' | 'pr-merged' | 'pr-closed' | 'commit';

export interface GitLinkView {
  glyph: GitGlyph;
  /** «org/app#42», «org/app · feature/FNG-12-login», «org/app@1a2b3c4». */
  ref: string;
  title: string;
  /** The kind / state word for screen readers and the tooltip. */
  kind: MessageKey;
  state: MessageKey | null;
}

export function gitLinkView(l: Pick<TaskGitLink, 'kind' | 'state' | 'repo' | 'ref' | 'title'>): GitLinkView {
  switch (l.kind) {
    case TaskGitLinkKind.PR: {
      const glyph: GitGlyph = l.state === TaskGitLinkState.MERGED ? 'pr-merged' : l.state === TaskGitLinkState.CLOSED ? 'pr-closed' : 'pr-open';
      const state: MessageKey = glyph === 'pr-merged' ? 'git.merged' : glyph === 'pr-closed' ? 'git.closed' : 'git.open';
      return { glyph, ref: `${l.repo}#${l.ref}`, title: l.title, kind: 'git.pr', state };
    }
    case TaskGitLinkKind.COMMIT:
      return { glyph: 'commit', ref: `${l.repo}@${l.ref.slice(0, 7)}`, title: l.title, kind: 'git.commit', state: null };
    default:
      return { glyph: 'branch', ref: l.repo ? `${l.repo} · ${l.ref}` : l.ref, title: l.title && l.title !== l.ref ? l.title : '', kind: 'git.branch', state: null };
  }
}

/** Only web pages open from a link row (the server stores what the provider sent). */
export const isWebUrl = (url: string): boolean => /^https?:\/\/[^\s/]+/i.test(url);

export const GIT_PROVIDERS: ReadonlyArray<{ v: GitProvider; label: MessageKey }> = [
  { v: GitProvider.GITHUB, label: 'git.github' },
  { v: GitProvider.GITLAB, label: 'git.gitlab' },
  { v: GitProvider.GITEA, label: 'git.gitea' },
];

/** The provider's path segment of the webhook URL (server: `vcs.GitHub` / `GitLab` / `Gitea`). */
const PROVIDER_SLUG: Readonly<Record<number, string>> = { [GitProvider.GITHUB]: 'github', [GitProvider.GITLAB]: 'gitlab', [GitProvider.GITEA]: 'gitea' };

/**
 * The webhook address of a board, known before saving: `<origin>/api/git/boards/<boardId>/<provider>`
 * (the server builds the same from PUBLIC_APP_URL). `serverUrl` is the origin the client talks
 * to; '' when unknown (then the UI says «the address appears after saving»). After saving the
 * UI shows the server's own `url`.
 */
export function gitHookUrl(serverUrl: string, boardId: string, provider: GitProvider): string {
  const slug = PROVIDER_SLUG[provider];
  const origin = serverUrl.trim().replace(/\/+$/, '');
  if (!slug || !/^https?:\/\/[^\s/]+/i.test(origin)) return '';
  return `${origin}/api/git/boards/${boardId}/${slug}`;
}

/** A strong random webhook secret: 32 random bytes, base64url (43 characters; the server wants 16..256). */
export function generateGitSecret(random: (a: Uint8Array) => Uint8Array = (a) => crypto.getRandomValues(a)): string {
  const bytes = random(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** One numbered step of the connection guide; `copy` puts an inline «Скопировать» after the text. */
export interface GitStep {
  text: MessageKey;
  copy?: 'url' | 'secret';
}

const steps = (p: 'github' | 'gitlab' | 'gitea', n: number, copy: Record<number, 'url' | 'secret'>): GitStep[] =>
  Array.from({ length: n }, (_, i) => ({ text: `git.step.${p}.${i + 1}` as MessageKey, copy: copy[i + 1] }));

/** The guide per provider — field names as the provider's UI shows them; events = what the server parses. */
export const GIT_STEPS: Readonly<Record<number, ReadonlyArray<GitStep>>> = {
  [GitProvider.GITHUB]: steps('github', 7, { 2: 'url', 4: 'secret' }),
  [GitProvider.GITLAB]: steps('gitlab', 5, { 2: 'url', 3: 'secret' }),
  [GitProvider.GITEA]: steps('gitea', 6, { 2: 'url', 4: 'secret' }),
};

/** The last two steps, the same for every provider: how a task is linked, how to check it. */
export const GIT_STEPS_COMMON: ReadonlyArray<GitStep> = [{ text: 'git.step.link' }, { text: 'git.step.check' }];
