-- The notice history of a user (ADR-0141): every task notice the server sent a user (TaskUpdate
-- with a notice, ADR-0042 §4 / ADR-0089), so the «Упоминания» inbox lists task events next to the
-- chat mentions. Written after the change commits (boards.sendNotices), one row per recipient.
--
-- task_notice_log  id: uuidv7 (time-ordered, the page cursor); kind: TaskNoticeKind number;
--                  the details as in TaskNotice. Access is checked on read (the task as the
--                  user sees it now). Rows older than 90 days are pruned by the due sweep.

-- +goose Up
CREATE TABLE task_notice_log (
    id           uuid PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    task_id      uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    kind         smallint NOT NULL,
    actor_id     uuid,
    message_id   uuid,
    text         text NOT NULL DEFAULT '',
    rule_id      uuid,
    re_requested boolean NOT NULL DEFAULT false,
    due_on       text NOT NULL DEFAULT '',
    days_left    integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_notice_log_user_idx ON task_notice_log (user_id, id DESC);
CREATE INDEX task_notice_log_task_idx ON task_notice_log (task_id);
CREATE INDEX task_notice_log_created_idx ON task_notice_log (created_at);

-- +goose Down
DROP TABLE task_notice_log;
