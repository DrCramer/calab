package boards

import (
	"context"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Journal kinds of the comments of a task (ADR-0091 §3): the comments are messages of the task
// room; the journal keeps what they said, also after an edit or a deletion.
const (
	kindComment       = "comment"
	kindCommentEdit   = "comment_edit"
	kindCommentDelete = "comment_delete"
)

// isCommentKind: a comment entry — not a change of the task (no task.updated webhook, no
// notifications of a field change).
func isCommentKind(kind string) bool {
	return kind == kindComment || kind == kindCommentEdit || kind == kindCommentDelete
}

// Snapshots of values in journal entries (ADR-0091 §3): the history reads after the label, file,
// milestone or task it names is gone.

// filesSnap: [{file_id, name, size, mime}] of the files ids, in the order of ids.
func filesSnap(ctx context.Context, q *sqlc.Queries, ids []uuid.UUID) ([]any, error) {
	out := []any{}
	if len(ids) == 0 {
		return out, nil
	}
	fs, err := q.FilesByID(ctx, ids)
	if err != nil {
		return nil, err
	}
	by := make(map[uuid.UUID]sqlc.FilesByIDRow, len(fs))
	for _, f := range fs {
		by[f.ID] = f
	}
	for _, id := range ids {
		if f, ok := by[id]; ok {
			out = append(out, fileSnap(f.ID, f.Name, f.Size, f.Mime))
		}
	}
	return out, nil
}

func fileSnap(id uuid.UUID, name string, size int64, mime string) map[string]any {
	return map[string]any{"file_id": id.String(), "name": name, "size": size, "mime": mime}
}

// attachmentsSnap: the files of a comment as its journal entries hold them.
func attachmentsSnap(rows []sqlc.ListAttachmentsRow) []any {
	out := make([]any, 0, len(rows))
	for _, r := range rows {
		out = append(out, fileSnap(r.File.ID, r.File.Name, r.File.Size, r.File.Mime))
	}
	return out
}

// taskRefs: key and title of tasks by id (missing ids: none).
func taskRefs(ctx context.Context, q *sqlc.Queries, ids ...*uuid.UUID) (map[uuid.UUID]sqlc.TaskRefsRow, error) {
	var want []uuid.UUID
	for _, id := range ids {
		if id != nil {
			want = append(want, *id)
		}
	}
	out := map[uuid.UUID]sqlc.TaskRefsRow{}
	if len(want) == 0 {
		return out, nil
	}
	rows, err := q.TaskRefs(ctx, want)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.ID] = r
	}
	return out, nil
}

// withRef adds key and title of the task id to m (nothing when there is none).
func withRef(m map[string]any, refs map[uuid.UUID]sqlc.TaskRefsRow, id *uuid.UUID) map[string]any {
	if id == nil {
		return m
	}
	if r, ok := refs[*id]; ok {
		m["key"], m["title"] = TaskKey(r.BoardKey, r.Number), r.Title
	}
	return m
}

// milestoneNames: the names of the board's milestones by id.
func milestoneNames(ctx context.Context, q *sqlc.Queries, boardID uuid.UUID) (map[uuid.UUID]string, error) {
	ms, err := q.ListBoardMilestones(ctx, []uuid.UUID{boardID})
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]string, len(ms))
	for _, m := range ms {
		out[m.ID] = m.Name
	}
	return out, nil
}

// withMilestone adds the name of the milestone id to m.
func withMilestone(m map[string]any, names map[uuid.UUID]string, id *uuid.UUID) map[string]any {
	if id != nil {
		if n, ok := names[*id]; ok {
			m["name"] = n
		}
	}
	return m
}

// commentSnap: a comment as its journal entries hold it — {message_id, text, attachments}.
func commentSnap(msg sqlc.Message, files []any) map[string]any {
	return map[string]any{"message_id": msg.ID.String(), "text": msg.Content, "attachments": files}
}

// labelsEntry: before / after of a "labels" entry — {label_ids, labels: [{id, name, color}]}.
func labelsEntry(it boardItems, ids []uuid.UUID) map[string]any {
	labels := make([]any, 0, len(ids))
	for _, id := range ids {
		if l, ok := it.labels[id]; ok {
			labels = append(labels, map[string]any{"id": id.String(), "name": l.Name, "color": color(l.Color)})
		}
	}
	return map[string]any{"label_ids": idsJSON(ids), "labels": labels}
}

// attachmentsEntry: before / after of an "attachments" entry — {file_ids, files: [{file_id,
// name, size, mime}]}.
func attachmentsEntry(ctx context.Context, q *sqlc.Queries, ids []uuid.UUID) (map[string]any, error) {
	files, err := filesSnap(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	return map[string]any{"file_ids": idsJSON(ids), "files": files}, nil
}
