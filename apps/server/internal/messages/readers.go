package messages

import (
	"bytes"
	"context"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

// recordReadSpan keeps the run of the seen marker of user in room (ADR-0140 §3): it moved from
// prev to upto — the run that ended at prev grows if it is fresh, otherwise a new run starts.
func recordReadSpan(ctx context.Context, q *sqlc.Queries, room, user uuid.UUID, prev *uuid.UUID, upto uuid.UUID) error {
	if prev != nil {
		n, err := q.ExtendReadSpan(ctx, sqlc.ExtendReadSpanParams{RoomID: room, UserID: user, PrevID: *prev, UptoID: upto})
		if err != nil || n > 0 {
			return err
		}
	}
	return q.InsertReadSpan(ctx, sqlc.InsertReadSpanParams{RoomID: room, UserID: user, AfterID: prev, UptoID: upto})
}

// readersOf returns who saw each of ms (all of room) on screen, by message id (ADR-0140): only
// the messages of author written since read receipts started; a guest author sees only the
// people of its rooms. Other messages are absent from the map.
func (h *Handlers) readersOf(ctx context.Context, acc perm.RoomAccess, room, author uuid.UUID, ms []sqlc.Message) (map[uuid.UUID][]*v1.MessageReader, error) {
	from, err := db.FeatureEpoch(ctx, h.db.Q, db.EpochReadReceipts)
	if err != nil {
		return nil, err
	}
	var mine []sqlc.Message
	for _, m := range ms {
		if m.AuthorID == author && m.RoomID == room && bytes.Compare(m.ID[:], from[:]) >= 0 {
			mine = append(mine, m)
		}
	}
	out := map[uuid.UUID][]*v1.MessageReader{}
	if len(mine) == 0 {
		return out, nil
	}
	first, last := mine[0].ID, mine[0].ID
	for _, m := range mine[1:] {
		if bytes.Compare(m.ID[:], first[:]) < 0 {
			first = m.ID
		}
		if bytes.Compare(m.ID[:], last[:]) > 0 {
			last = m.ID
		}
	}
	spans, err := h.db.Q.ListReadSpansCovering(ctx, sqlc.ListReadSpansCoveringParams{RoomID: room, AuthorID: author, FirstID: first, LastID: last})
	if err != nil {
		return nil, err
	}
	var allowed map[uuid.UUID]bool
	if acc.Role == perm.RoleGuest {
		if allowed, err = rooms.GuestVisibleUsers(ctx, h.db.Q, nil, acc.WorkspaceID, author); err != nil {
			return nil, err
		}
	}
	for _, m := range mine {
		out[m.ID] = coveringReaders(m, spans, allowed)
	}
	return out, nil
}

// coveringReaders picks for message m who saw it among spans (ADR-0140 §3): a person whose run
// has after_id < m <= upto_id, at the message time clamped into the run (the earliest run if
// several cover it), ordered by that time. allowed, when set, limits the people (a guest author).
func coveringReaders(m sqlc.Message, spans []sqlc.ListReadSpansCoveringRow, allowed map[uuid.UUID]bool) []*v1.MessageReader {
	at := map[uuid.UUID]time.Time{}
	for _, s := range spans {
		if bytes.Compare(s.UptoID[:], m.ID[:]) < 0 || (s.AfterID != nil && bytes.Compare(s.AfterID[:], m.ID[:]) >= 0) {
			continue
		}
		if allowed != nil && !allowed[s.UserID] {
			continue
		}
		t := m.CreatedAt
		if t.Before(s.FirstAt) {
			t = s.FirstAt
		}
		if t.After(s.LastAt) {
			t = s.LastAt
		}
		if prev, ok := at[s.UserID]; !ok || t.Before(prev) {
			at[s.UserID] = t
		}
	}
	out := make([]*v1.MessageReader, 0, len(at))
	for u, t := range at {
		out = append(out, &v1.MessageReader{UserId: u.String(), ReadAt: timestamppb.New(t)})
	}
	slices.SortFunc(out, func(a, b *v1.MessageReader) int {
		if c := a.GetReadAt().AsTime().Compare(b.GetReadAt().AsTime()); c != 0 {
			return c
		}
		return strings.Compare(a.GetUserId(), b.GetUserId())
	})
	return out
}

// withReadBy fills Message.read_by of the caller's own messages among out (REST answers to the
// author only, ADR-0140 §4). A bot acting for a consenting member (ADR-0111) gets none: its token
// is the bot owner's, and the member's consent does not cover what others read.
func (h *Handlers) withReadBy(r *http.Request, acc perm.RoomAccess, room uuid.UUID, ms []sqlc.Message, out []*v1.Message) error {
	if auth.MustFromContext(r.Context()).ForMember {
		return nil
	}
	by, err := h.readersOf(r.Context(), acc, room, uid(r), ms)
	if err != nil {
		return err
	}
	for i, m := range ms {
		if rs, ok := by[m.ID]; ok && i < len(out) {
			out[i].ReadBy = rs
		}
	}
	return nil
}

// peerRead is the furthest seen marker of the other people of room (ADR-0140 §2): the value of
// READ_RECEIPT for rooms READY does not list.
func (h *Handlers) peerRead(ctx context.Context, room, me uuid.UUID) (string, error) {
	prs, err := h.db.Q.ListPeerReads(ctx, sqlc.ListPeerReadsParams{UserID: me, RoomIds: []uuid.UUID{room}})
	if err != nil || len(prs) == 0 {
		return "", err
	}
	return prs[0].LastReadMessageID.String(), nil
}

// readers answers GET /api/rooms/{id}/messages/{messageId}/readers: who saw the message — the
// author only (ADR-0140 §4).
func (h *Handlers) readers(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.ReadAccess(r, roomID)
	if err != nil {
		return err
	}
	id, err := httpx.PathUUID(r, "messageId", "message")
	if err != nil {
		return err
	}
	since, err := h.clearedBefore(r, acc, roomID)
	if err != nil {
		return err
	}
	if since != nil && bytes.Compare(id[:], since[:]) <= 0 {
		return httpx.NotFound("message")
	}
	m, err := h.db.Q.GetMessage(r.Context(), id)
	if db.IsNotFound(err) || (err == nil && (m.RoomID != roomID || m.DeletedAt != nil)) {
		return httpx.NotFound("message")
	}
	if err != nil {
		return err
	}
	if m.AuthorID != uid(r) || auth.MustFromContext(r.Context()).ForMember { // ADR-0111: not the member's bot
		return httpx.Forbidden("only the author sees who read the message")
	}
	by, err := h.readersOf(r.Context(), acc, roomID, m.AuthorID, []sqlc.Message{m})
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListMessageReadersResponse{Readers: by[m.ID]})
	return nil
}
