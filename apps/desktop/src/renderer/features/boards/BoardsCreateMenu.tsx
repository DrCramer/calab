import { AiState } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { Bot, FolderPlus, LayoutGrid, ListPlus, SquareKanban } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import * as Dropdown from '../../components/radix/dropdown-menu';
import { CreateButton } from '../../components/CreateButton';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { aiStatusKey, smartOffKey } from '../../lib/ai';
import { api } from '../../lib/api/endpoints';
import { mayCreateBoards } from '../../lib/permissions';
import { planHasAI } from '../../lib/plan';
import { openBoard } from '../../services/boards';
import { useBoards, workspaceBoards } from '../../stores/boards';
import { useBoardsUi } from '../../stores/boardsUi';
import { useSession } from '../../stores/session';
import { useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { NewCategoryDialog } from './BoardsList';
import { createMenuPlan, pickTaskBoard } from './createMenuModel';
import { CREATE_TASKS, hasBit } from './model';

/** «Создать задачу»: the boards tab on that board, then its create dialog (reused, no new requests). */
export function createTaskOn(workspaceId: string, boardId: string): void {
  if (!boardId) return;
  openBoard(workspaceId, boardId);
  useBoardsUi.getState().openCreate({ boardId });
}

/**
 * The boards section's «+» (CBF-58, the same dropdown as «Команда»): «Создать задачу» (the last
 * used / open / first board), the boards where I may create tasks, a separator, «Создать категорию»
 * and «Создать доску» (CREATE_BOARDS). One component for the desktop column and the phone root.
 */
export function BoardsCreateMenu({ workspaceId }: { workspaceId: string }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const creator = mayCreateBoards(useMemberRoles(workspaceId, me));
  // Ids only (a shallow-compared slice): a card move elsewhere does not re-render the menu.
  const taskBoards = useBoards(useShallow((s) => workspaceBoards(s.boards, workspaceId).filter((b) => hasBit(b.permissions, CREATE_TASKS)).map((b) => b.id)));
  const [newCat, setNewCat] = useState(false);
  const [open, setOpen] = useState(false);
  const plan = createMenuPlan(creator, taskBoards);
  if (plan.empty) return null;
  return (
    <>
      <Dropdown.Root modal={false} open={open} onOpenChange={setOpen}>
        <Dropdown.Trigger asChild>
          <CreateButton label={t('shell.create')} data-testid="section-create-board" />
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={cx(menuBox, 'w-64')} sideOffset={4} align="end" collisionPadding={16} data-testid="boards-create-menu">
            {plan.tasks ? (
              <>
                <Dropdown.Item
                  className={menuItem}
                  onSelect={() => {
                    const ui = useBoardsUi.getState();
                    createTaskOn(workspaceId, pickTaskBoard(taskBoards, ui.lastBoard[workspaceId], ui.boardOf[workspaceId]));
                  }}
                  data-testid="boards-create-task"
                >
                  <ListPlus className="size-4" aria-hidden /> {t('shell.createTask')}
                </Dropdown.Item>
                <SmartItem workspaceId={workspaceId} open={open} />
                {taskBoards.map((id) => (
                  <BoardItem key={id} workspaceId={workspaceId} boardId={id} />
                ))}
              </>
            ) : null}
            {plan.separator ? <Dropdown.Separator className={menuSeparator} /> : null}
            {plan.manage ? (
              <>
                <Dropdown.Item className={menuItem} onSelect={() => setNewCat(true)} data-testid="board-category-new">
                  <FolderPlus className="size-4" aria-hidden /> {t('shell.categoryCreate')}
                </Dropdown.Item>
                <Dropdown.Item className={menuItem} onSelect={() => useBoardsUi.getState().openSettings({ boardId: '', workspaceId })} data-testid="boards-create-board">
                  <LayoutGrid className="size-4" aria-hidden /> {t('boards.createBoard')}
                </Dropdown.Item>
              </>
            ) : null}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      {newCat ? <NewCategoryDialog workspaceId={workspaceId} onClose={() => setNewCat(false)} /> : null}
    </>
  );
}

/**
 * «Создать умную задачу» (CBF-68): on only when the plan includes AI (CBF-69: Business), the
 * workspace's AI is connected and its last check passed (GET …/ai/status, read while the menu is
 * open — not at all without the plan); otherwise off with the reason under it. The server refuses
 * all of it too — this only spares a useless dialog.
 */
function SmartItem({ workspaceId, open }: { workspaceId: string; open: boolean }): ReactNode {
  const planAI = useWorkspaces((s) => planHasAI(s.byId[workspaceId]?.ws.plan));
  const q = useQuery({ queryKey: aiStatusKey(workspaceId), queryFn: ({ signal }) => api.ai.status(workspaceId, signal), enabled: open && planAI, staleTime: 0 });
  const off = smartOffKey(q.isError ? AiState.UNSPECIFIED : q.data?.state, planAI);
  return (
    <Dropdown.Item
      className={cx(menuItem, off && 'h-auto min-h-8 items-start py-1.5 data-[disabled]:opacity-100')}
      disabled={off !== null}
      onSelect={() => useBoardsUi.getState().openSmart(workspaceId)}
      data-testid="boards-create-smart"
    >
      <Bot className={cx('size-4 shrink-0', off && 'mt-0.5 text-faint')} aria-hidden />
      {off ? (
        <span className="flex min-w-0 flex-col">
          <span className="text-faint">{t('smart.menu')}</span>
          <span className="text-caption text-muted" data-testid="boards-create-smart-hint">
            {t(off)}
          </span>
        </span>
      ) : (
        t('smart.menu')
      )}
    </Dropdown.Item>
  );
}

/** A board in the list: its emoji and name; a click opens it with the create-task dialog. */
function BoardItem({ workspaceId, boardId }: { workspaceId: string; boardId: string }): ReactNode {
  const name = useBoards((s) => s.boards[boardId]?.name ?? '');
  const emoji = useBoards((s) => s.boards[boardId]?.emoji ?? '');
  return (
    <Dropdown.Item className={menuItem} onSelect={() => createTaskOn(workspaceId, boardId)}>
      {emoji ? <span className="grid w-4 place-items-center text-body leading-none">{emoji}</span> : <SquareKanban className="size-4" aria-hidden />}
      <span className="min-w-0 truncate">{name}</span>
    </Dropdown.Item>
  );
}
