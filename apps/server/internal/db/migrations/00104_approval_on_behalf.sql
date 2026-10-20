-- Approvals recorded on behalf of an approver (ADR-0108).
--
-- task_approvers.on_behalf: a board manager (MANAGE_BOARD) recorded this approval for the
-- approver; false = the approver's own vote. recorded_by: that manager. Both are cleared whenever
-- the vote changes again (the approver's own vote, a withdrawal, a reset). on_behalf is the fact
-- and recorded_by only its author: a hard delete of the recorder nulls recorded_by (ON DELETE SET
-- NULL) and the approval stays marked as recorded on behalf — never a personal vote.

-- +goose Up
ALTER TABLE task_approvers
    ADD COLUMN on_behalf boolean NOT NULL DEFAULT false,
    ADD COLUMN recorded_by uuid REFERENCES users (id) ON DELETE SET NULL,
    ADD CONSTRAINT task_approvers_on_behalf_approved CHECK (NOT on_behalf OR state = 'approved'),
    ADD CONSTRAINT task_approvers_recorded_on_behalf CHECK (recorded_by IS NULL OR on_behalf);

-- +goose Down
ALTER TABLE task_approvers
    DROP CONSTRAINT task_approvers_recorded_on_behalf,
    DROP CONSTRAINT task_approvers_on_behalf_approved,
    DROP COLUMN recorded_by,
    DROP COLUMN on_behalf;
