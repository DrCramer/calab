import { useState, type ReactNode } from 'react';
import { cx } from '../../../components/ui';
import { MAX_TITLE } from '../../../lib/canvas/types';

/**
 * A frame's name as a one-line field (the properties panel, the frames panel's inline rename). It keeps its own draft
 * while focused, so a co-author's rename does not jump under the caret; Enter or leaving it writes the name (one undo
 * step), Esc gives the old one back. `onDone` runs after either (the frames panel closes its field, the panel refocuses
 * the canvas).
 */
export function FrameTitleField({
  value, label, onCommit, onDone, autoFocus, placeholder, className, testId,
}: {
  value: string;
  label: string;
  onCommit: (title: string) => void;
  onDone?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
  testId: string;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(autoFocus ? value : null);
  const finish = (save: boolean): void => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (save && next !== value) onCommit(next);
    onDone?.();
  };
  return (
    <input
      type="text"
      autoComplete="off"
      spellCheck={false}
      aria-label={label}
      maxLength={MAX_TITLE}
      autoFocus={autoFocus}
      placeholder={placeholder}
      value={draft ?? value}
      onFocus={(e) => {
        if (draft === null) setDraft(value);
        e.currentTarget.select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        // The canvas hotkeys never see what is typed here.
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      className={cx(
        'selectable min-w-0 rounded-[var(--radius-control)] border border-line bg-elev px-2 text-body text-fg placeholder:text-faint',
        className,
      )}
      data-testid={testId}
    />
  );
}
