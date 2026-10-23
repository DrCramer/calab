-- ADR-0117 step 1: the telephony exchange of a workspace — internal numbers, groups, voice menus.

-- name: LockSipPBX :exec
-- Serializes changes of one workspace's exchange (counts, numbers, group membership).
SELECT pg_advisory_xact_lock(hashtext('calaba.sip.pbx.' || sqlc.arg('workspace_id')::uuid::text));

-- name: ListSipExtensions :many
SELECT * FROM sip_extensions WHERE workspace_id = $1 ORDER BY number, id;

-- name: GetSipExtension :one
SELECT * FROM sip_extensions WHERE id = $1 AND workspace_id = $2;

-- name: CountSipExtensions :one
SELECT count(*)::integer FROM sip_extensions WHERE workspace_id = $1;

-- name: InsertSipExtension :one
INSERT INTO sip_extensions (workspace_id, number, kind, user_id, group_id, description, created_by, external_blocked)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: UpdateSipExtension :one
UPDATE sip_extensions SET number = $3, user_id = $4, description = $5, external_blocked = $6
WHERE id = $1 AND workspace_id = $2
RETURNING *;

-- name: DeleteSipExtension :one
DELETE FROM sip_extensions WHERE id = $1 AND workspace_id = $2 AND kind = 'user'
RETURNING *;

-- name: SetMemberSipExtension :one
-- WorkspaceMember.extension, kept with the member's sip_extensions row.
UPDATE workspace_members SET sip_extension = $3
WHERE workspace_id = $1 AND user_id = $2
RETURNING *;

-- name: ListSipGroups :many
SELECT * FROM sip_groups WHERE workspace_id = $1 ORDER BY id;

-- name: GetSipGroup :one
SELECT * FROM sip_groups WHERE id = $1 AND workspace_id = $2;

-- name: CountSipGroups :one
SELECT count(*)::integer FROM sip_groups WHERE workspace_id = $1;

-- name: InsertSipGroup :one
INSERT INTO sip_groups (workspace_id, name, strategy, ring_sec, member_ring_sec,
                        on_fail_kind, on_fail_menu_id, on_fail_extension_id, on_fail_group_id,
                        fallback_enabled, fallback_sec)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
RETURNING *;

-- name: UpdateSipGroup :one
UPDATE sip_groups
SET name = $3, strategy = $4, ring_sec = $5, member_ring_sec = $6, on_fail_kind = $7,
    on_fail_menu_id = $8, on_fail_extension_id = $9, on_fail_group_id = $10,
    fallback_enabled = $11, fallback_sec = $12,
    next_position = CASE WHEN sqlc.arg('reset_position')::boolean THEN 0 ELSE next_position END,
    updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING *;

-- name: DeleteSipGroup :execrows
DELETE FROM sip_groups WHERE id = $1 AND workspace_id = $2;

-- name: ListSipGroupMembers :many
SELECT * FROM sip_group_members WHERE workspace_id = $1 ORDER BY group_id, position;

-- name: ListSipGroupMembersOf :many
SELECT * FROM sip_group_members WHERE group_id = $1 ORDER BY position;

-- name: DeleteSipGroupMembers :exec
DELETE FROM sip_group_members WHERE group_id = $1;

-- name: InsertSipGroupMember :exec
INSERT INTO sip_group_members (workspace_id, group_id, extension_id, position) VALUES ($1, $2, $3, $4);

-- name: ListSipIvrMenus :many
SELECT * FROM sip_ivr_menus WHERE workspace_id = $1 ORDER BY id;

-- name: GetSipIvrMenu :one
SELECT * FROM sip_ivr_menus WHERE id = $1 AND workspace_id = $2;

-- name: CountSipIvrMenus :one
SELECT count(*)::integer FROM sip_ivr_menus WHERE workspace_id = $1;

-- name: InsertSipIvrMenu :one
INSERT INTO sip_ivr_menus (workspace_id, name, prompt_file_id, prompt_duration_ms, input_timeout_sec, repeats,
                           no_input_kind, no_input_menu_id, no_input_extension_id, no_input_group_id, updated_by,
                           dial_extensions)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING *;

-- name: UpdateSipIvrMenu :one
UPDATE sip_ivr_menus
SET name = $3, prompt_file_id = $4, prompt_duration_ms = $5, input_timeout_sec = $6, repeats = $7,
    no_input_kind = $8, no_input_menu_id = $9, no_input_extension_id = $10, no_input_group_id = $11,
    updated_by = $12, dial_extensions = $13, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING *;

-- name: DeleteSipIvrMenu :one
DELETE FROM sip_ivr_menus WHERE id = $1 AND workspace_id = $2
RETURNING *;

-- name: ListSipIvrItems :many
SELECT * FROM sip_ivr_items WHERE workspace_id = $1 ORDER BY menu_id, digit;

-- name: ListSipIvrItemsOf :many
SELECT * FROM sip_ivr_items WHERE menu_id = $1 ORDER BY digit;

-- name: DeleteSipIvrItems :exec
DELETE FROM sip_ivr_items WHERE menu_id = $1;

-- name: InsertSipIvrItem :exec
INSERT INTO sip_ivr_items (workspace_id, menu_id, digit, action_kind, action_menu_id, action_extension_id, action_group_id)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: IsSipPromptFile :one
-- The file is the prompt or the recording notice of a voice menu (files.CanRead:
-- MANAGE_INTEGRATIONS of its workspace).
SELECT EXISTS (SELECT 1 FROM sip_ivr_menus WHERE prompt_file_id = $1 OR notice_file_id = $1)::boolean;

-- name: SetSipIvrMenuNotice :one
-- The recording notice of a menu (ADR-0131): a new file, or NULL to remove it.
UPDATE sip_ivr_menus SET notice_file_id = $3, notice_duration_ms = $4, updated_by = $5, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING *;

-- name: ListSipRouteMembers :many
-- The members behind user numbers, for routing: role and bot flag (guests never ring).
SELECT e.id AS extension_id, m.user_id, m.role, u.is_bot
FROM sip_extensions e
JOIN workspace_members m ON m.workspace_id = e.workspace_id AND m.user_id = e.user_id
JOIN users u ON u.id = m.user_id
WHERE e.workspace_id = $1 AND e.kind = 'user';
