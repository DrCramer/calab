-- Approvals recorded on behalf of an approver (ADR-0108).
--
-- task_approvers.recorded_by: the board manager (MANAGE_BOARD) who recorded this approval for
-- the approver; NULL = the approver's own vote. Cleared whenever the vote changes again (the
-- approver's own vote, a withdrawal, a reset). No ON DELETE action: the audit fact must not turn
-- into a personal vote when a recorder is deleted (users are not deleted; a hard delete of a
-- recorder fails until the vote changes).

-- +goose Up
ALTER TABLE task_approvers ADD COLUMN recorded_by uuid REFERENCES users (id);
ALTER TABLE task_approvers ADD CONSTRAINT task_approvers_recorded_approved
    CHECK (recorded_by IS NULL OR state = 'approved');

-- +goose Down
ALTER TABLE task_approvers DROP CONSTRAINT task_approvers_recorded_approved;
ALTER TABLE task_approvers DROP COLUMN recorded_by;
