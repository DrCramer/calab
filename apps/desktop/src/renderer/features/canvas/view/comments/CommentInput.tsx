/**
 * The composer of canvas comments (ADR-0127 wave 4): the chat's CommentComposer (owner 23.10: «как в
 * чате») with the canvas's @ list — only members the server says see the canvas are offered
 * (GET …/comments/mention-access, cached a minute; asked when the field is first focused, nobody is
 * offered until it answers). The wire text holds `@<user_id>` (lib/mentions), ≤ COMMENT_MAX characters
 * and ≤ COMMENT_MENTIONS_MAX mentions.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { t } from '../../../../i18n';
import { mentionCount } from '../../../../lib/canvas/comments';
import type { MentionCandidate } from '../../../../lib/mentions';
import { canvasMentionAccess, cachedCanvasMentionAccess, COMMENT_MAX, COMMENT_MENTIONS_MAX } from '../../../../services/canvasComments';
import { myUserId } from '../../../../stores/session';
import { isGuest, useWorkspaces } from '../../../../stores/workspaces';
import { CommentComposer, type CommentEdit, type CommentMentionSource } from '../../../chat/CommentComposer';

export interface CommentInputProps {
  canvasId: string;
  workspaceId: string;
  placeholder: string;
  editing?: CommentEdit | null | undefined;
  onCancelEdit?: (() => void) | undefined;
  onSubmit: (wire: string, editId?: string) => Promise<boolean>;
  onEscape?: (() => void) | undefined;
  autoFocus?: boolean | undefined;
  bar?: ReactNode;
  className?: string | undefined;
}

export function CommentInput({ canvasId, workspaceId, ...rest }: CommentInputProps): ReactNode {
  const [see, setSee] = useState<ReadonlySet<string> | undefined>(() => cachedCanvasMentionAccess(canvasId));
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const users = useWorkspaces((s) => s.users);
  const me = myUserId();

  // Who may be called: asked when the field is used, not for every thread on screen.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!asked || see) return undefined;
    let live = true;
    const ids = Object.values(members ?? {}).flatMap((m) => (m.user && m.user.id !== me && !users[m.user.id]?.isBot ? [m.user.id] : []));
    void canvasMentionAccess(canvasId, ids).then((v) => {
      if (!live) return;
      // A failed ask is asked again the next time the field is used, not never.
      if (v) setSee(v);
      else setAsked(false);
    });
    return () => {
      live = false;
    };
  }, [asked, see, canvasId, members, users, me]);

  const mentions = useMemo<CommentMentionSource>(() => {
    const candidates: MentionCandidate[] = [];
    const all: Array<{ id: string; name: string }> = [];
    const guests = new Set<string>();
    for (const m of Object.values(members ?? {})) {
      const u = m.user;
      if (!u) continue;
      const name = m.nickname || u.displayName;
      all.push({ id: u.id, name });
      if (u.id === me || !see?.has(u.id)) continue;
      if (isGuest(m)) guests.add(u.id);
      candidates.push({ id: u.id, name, alt: m.nickname && m.nickname !== u.displayName ? [u.displayName] : [], ...(u.username ? { nick: u.username } : {}) });
    }
    return { candidates, all, guests };
  }, [members, see, me]);
  const limit = useMemo(() => ({ max: COMMENT_MENTIONS_MAX, label: t('canvasComments.tooManyMentions', { n: COMMENT_MENTIONS_MAX }), count: mentionCount }), []);

  return (
    <CommentComposer
      workspaceId={workspaceId}
      maxLength={COMMENT_MAX}
      mentions={mentions}
      mentionLimit={limit}
      onFieldFocus={() => setAsked(true)}
      testId="canvas-comment-input"
      sendTestId="canvas-comment-send"
      {...rest}
    />
  );
}
