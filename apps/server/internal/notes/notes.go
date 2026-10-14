// Package notes implements notes shelves (ADR-0039): personal rooms of one user (type 'notes',
// no workspace, the owner is the only row in dm_members). Like a DM, a shelf's messages, files,
// reactions, pins, read state and search go through the room endpoints and access is by
// membership (perm.Resolver: RoomAccess.DM and .Notes). This package creates, lists, renames,
// reorders and deletes shelves and computes the personal file quota.
package notes

import (
	"context"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/pbconv"
)

// Limits (ADR-0039).
const (
	MaxShelves = 20 // per user
	MaxName    = 40 // characters
)

// ReasonNotesLimit is ApiError.reason of the 409 on creating a shelf over MaxShelves.
const ReasonNotesLimit = "NOTES_LIMIT"

// ReasonPersonalQuota is ApiError.reason of the 413 FILE_QUOTA_EXCEEDED of the personal quota.
const ReasonPersonalQuota = "PERSONAL_QUOTA"

// Handlers serves /api/notes.
type Handlers struct {
	db           *db.DB
	events       events.Publisher
	defaultQuota int64 // DEFAULT_PERSONAL_QUOTA_BYTES
}

// NewHandlers creates the notes handlers; defaultQuota is the personal quota of users
// without their own (users.storage_quota_bytes NULL).
func NewHandlers(d *db.DB, ev events.Publisher, defaultQuota int64) *Handlers {
	return &Handlers{db: d, events: ev, defaultQuota: defaultQuota}
}

// Routes registers authenticated routes; wrap must apply auth + perm resolver.
func (h *Handlers) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/notes", wrap(httpx.HandlerFunc(h.list)))
	mux.Handle("POST /api/notes", wrap(httpx.HandlerFunc(h.create)))
	mux.Handle("PATCH /api/notes/{id}", wrap(httpx.HandlerFunc(h.update)))
	mux.Handle("DELETE /api/notes/{id}", wrap(httpx.HandlerFunc(h.delete)))
}

// Shelf converts a ListNotes row.
func Shelf(row sqlc.ListNotesRow) *v1.NotesShelf {
	room := pbconv.DMRoom(row.Room)
	out := &v1.NotesShelf{Room: room, Emoji: row.Room.Emoji}
	if row.HasMessages {
		room.LastMessageId = row.LastMessageID.String()
		room.LastMessageAt = timestamppb.New(row.LastMessageAt)
		out.LastMessage = &v1.DmLastMessage{
			Id: room.GetLastMessageId(), AuthorId: row.LastAuthorID.String(), Content: row.LastPreview,
			AttachmentCount: uint32(max(row.LastAttachments, 0)), CreatedAt: room.GetLastMessageAt(), //nolint:gosec // 0..20
			StickerEmoji: row.LastStickerEmoji,
		}
	}
	return out
}

// List returns the user's shelves by position (READY and GET /api/notes).
func List(ctx context.Context, q *sqlc.Queries, userID uuid.UUID) ([]*v1.NotesShelf, error) {
	rows, err := q.ListNotes(ctx, sqlc.ListNotesParams{UserID: userID})
	if err != nil {
		return nil, err
	}
	out := make([]*v1.NotesShelf, len(rows))
	for i, row := range rows {
		out[i] = Shelf(row)
	}
	return out, nil
}

// one returns one shelf of the user (404 when it is not theirs).
func one(ctx context.Context, q *sqlc.Queries, userID, roomID uuid.UUID) (*v1.NotesShelf, error) {
	rows, err := q.ListNotes(ctx, sqlc.ListNotesParams{UserID: userID, RoomID: &roomID})
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, httpx.NotFound("notes")
	}
	return Shelf(rows[0]), nil
}

// Quota is a user's personal file quota (ADR-0039 §5).
type Quota struct {
	Limit     int64 // effective quota in bytes
	Used      int64
	IsDefault bool // the server default applies
}

// PersonalQuota returns the user's effective personal quota and its usage; defaultQuota
// applies when the user has none of their own.
func PersonalQuota(ctx context.Context, q *sqlc.Queries, userID uuid.UUID, defaultQuota int64) (Quota, error) {
	u, err := q.GetUser(ctx, userID)
	if err != nil {
		return Quota{}, err
	}
	used, err := q.PersonalStorageBytes(ctx, &userID)
	if err != nil {
		return Quota{}, err
	}
	if u.StorageQuotaBytes == nil {
		return Quota{Limit: defaultQuota, Used: used, IsDefault: true}, nil
	}
	return Quota{Limit: *u.StorageQuotaBytes, Used: used}, nil
}

// Proto is the wire form of the quota.
func (qt Quota) Proto() *v1.UserStorageQuota {
	return &v1.UserStorageQuota{QuotaBytes: uint64(max(qt.Limit, 0)), UsedBytes: uint64(max(qt.Used, 0)), IsDefault: qt.IsDefault}
}

// ErrPersonalQuota is the 413 of an upload into a shelf over the personal quota.
var ErrPersonalQuota = httpx.Coded(http.StatusRequestEntityTooLarge, v1.ErrorCode_ERROR_CODE_FILE_QUOTA_EXCEEDED, "personal storage quota exceeded")

// CheckUpload refuses an upload of size bytes into a shelf that does not fit the personal
// quota. Call it inside the upload transaction after files' storage lock (the lock
// serializes concurrent uploads between the check and the insert).
func CheckUpload(ctx context.Context, q *sqlc.Queries, userID uuid.UUID, size, defaultQuota int64) error {
	qt, err := PersonalQuota(ctx, q, userID, defaultQuota)
	if err != nil {
		return err
	}
	if qt.Used+size > qt.Limit {
		return ErrPersonalQuota.WithDetails(ReasonPersonalQuota, uint64(max(qt.Used, 0)), uint64(max(qt.Limit, 0)))
	}
	return nil
}

func uid(r *http.Request) uuid.UUID { return auth.MustFromContext(r.Context()).UserID }

// allowed rejects bots and guest accounts (ADR-0039 §3).
func (h *Handlers) allowed(r *http.Request) error {
	if auth.MustFromContext(r.Context()).IsBot {
		return auth.ErrBotNotAllowed
	}
	u, err := h.db.Q.GetUser(r.Context(), uid(r))
	if err != nil {
		return err
	}
	if u.IsGuest || u.IsBot {
		return httpx.Forbidden("notes are not available for guest accounts and bots")
	}
	return nil
}

func validName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > MaxName {
		return "", httpx.Validation("name", "name must be 1 to 40 characters")
	}
	return s, nil
}

func validEmoji(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s != "" && !messages.ValidEmoji(s) {
		return "", httpx.Validation("emoji", "emoji must be one emoji")
	}
	return s, nil
}

// list: GET /api/notes.
func (h *Handlers) list(w http.ResponseWriter, r *http.Request) error {
	if err := h.allowed(r); err != nil {
		return err
	}
	out, err := List(r.Context(), h.db.Q, uid(r))
	if err != nil {
		return err
	}
	qt, err := PersonalQuota(r.Context(), h.db.Q, uid(r), h.defaultQuota)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListNotesResponse{Shelves: out, Storage: qt.Proto()})
	return nil
}

// create: POST /api/notes {name, emoji}.
func (h *Handlers) create(w http.ResponseWriter, r *http.Request) error {
	if err := h.allowed(r); err != nil {
		return err
	}
	var req v1.CreateNotesRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := validName(req.GetName())
	if err != nil {
		return err
	}
	emoji, err := validEmoji(req.GetEmoji())
	if err != nil {
		return err
	}
	me := uid(r)
	var room sqlc.Room
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockNotes(r.Context(), me); err != nil {
			return err
		}
		n, err := q.CountNotes(r.Context(), me)
		if err != nil {
			return err
		}
		if n >= MaxShelves {
			return httpx.Conflict("at most 20 notes shelves").WithDetails(ReasonNotesLimit, uint64(max(n, 0)), MaxShelves)
		}
		if room, err = q.CreateNotesRoom(r.Context(), sqlc.CreateNotesRoomParams{Name: name, Emoji: emoji, UserID: me}); err != nil {
			return err
		}
		return q.AddDMMembers(r.Context(), sqlc.AddDMMembersParams{RoomID: room.ID, UserIds: []uuid.UUID{me}})
	})
	if err != nil {
		return err
	}
	s, err := one(r.Context(), h.db.Q, me, room.ID)
	if err != nil {
		return err
	}
	h.events.User(r.Context(), me, &v1.DispatchEvent{Event: &v1.DispatchEvent_NotesCreate{NotesCreate: &v1.NotesCreate{Shelf: s}}})
	httpx.Write(w, http.StatusCreated, &v1.CreateNotesResponse{Shelf: s})
	return nil
}

// update: PATCH /api/notes/{id} {name?, emoji?, position?}.
func (h *Handlers) update(w http.ResponseWriter, r *http.Request) error {
	if err := h.allowed(r); err != nil {
		return err
	}
	roomID, err := httpx.PathUUID(r, "id", "notes")
	if err != nil {
		return err
	}
	var req v1.UpdateNotesRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	p := sqlc.UpdateNotesRoomParams{ID: roomID}
	if req.Name != nil {
		name, err := validName(req.GetName())
		if err != nil {
			return err
		}
		p.Name = &name
	}
	if req.Emoji != nil {
		emoji, err := validEmoji(req.GetEmoji())
		if err != nil {
			return err
		}
		p.Emoji = &emoji
	}
	me := uid(r)
	moved := []uuid.UUID{roomID}
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockNotes(r.Context(), me); err != nil {
			return err
		}
		if _, err := q.GetNotesRoom(r.Context(), sqlc.GetNotesRoomParams{UserID: me, RoomID: roomID}); err != nil {
			if db.IsNotFound(err) {
				return httpx.NotFound("notes")
			}
			return err
		}
		if _, err := q.UpdateNotesRoom(r.Context(), p); err != nil {
			return err
		}
		if req.Position == nil {
			return nil
		}
		ids, err := reorder(r.Context(), q, me, roomID, int(req.GetPosition()))
		moved = ids
		return err
	})
	if err != nil {
		return err
	}
	var out *v1.NotesShelf
	for _, id := range moved {
		s, err := one(r.Context(), h.db.Q, me, id)
		if err != nil {
			return err
		}
		if id == roomID {
			out = s
		}
		h.events.User(r.Context(), me, &v1.DispatchEvent{Event: &v1.DispatchEvent_NotesUpdate{NotesUpdate: &v1.NotesUpdate{Shelf: s}}})
	}
	httpx.Write(w, http.StatusOK, &v1.UpdateNotesResponse{Shelf: out})
	return nil
}

// reorder moves the shelf to index pos (clamped) and renumbers the list 0..n-1; it returns
// the shelves whose position changed (always including the moved one).
func reorder(ctx context.Context, q *sqlc.Queries, userID, roomID uuid.UUID, pos int) ([]uuid.UUID, error) {
	rows, err := q.ListNotes(ctx, sqlc.ListNotesParams{UserID: userID})
	if err != nil {
		return nil, err
	}
	order := make([]sqlc.Room, 0, len(rows))
	var self sqlc.Room
	for _, row := range rows {
		if row.Room.ID == roomID {
			self = row.Room
			continue
		}
		order = append(order, row.Room)
	}
	pos = min(max(pos, 0), len(order))
	order = append(order[:pos], append([]sqlc.Room{self}, order[pos:]...)...)
	changed := []uuid.UUID{roomID}
	for i, room := range order {
		if int(room.Position) == i {
			continue
		}
		p := int32(i) //nolint:gosec // ≤ 20
		if _, err := q.UpdateNotesRoom(ctx, sqlc.UpdateNotesRoomParams{ID: room.ID, Position: &p}); err != nil {
			return nil, err
		}
		if room.ID != roomID {
			changed = append(changed, room.ID)
		}
	}
	return changed, nil
}

// delete: DELETE /api/notes/{id} — the shelf with all its messages (ADR-0039 §4).
func (h *Handlers) delete(w http.ResponseWriter, r *http.Request) error {
	if err := h.allowed(r); err != nil {
		return err
	}
	roomID, err := httpx.PathUUID(r, "id", "notes")
	if err != nil {
		return err
	}
	me := uid(r)
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if _, err := q.GetNotesRoom(r.Context(), sqlc.GetNotesRoomParams{UserID: me, RoomID: roomID}); err != nil {
			if db.IsNotFound(err) {
				return httpx.NotFound("notes")
			}
			return err
		}
		_, err := q.DeleteNotesRoom(r.Context(), roomID)
		return err
	})
	if err != nil {
		return err
	}
	h.events.User(r.Context(), me, &v1.DispatchEvent{Event: &v1.DispatchEvent_NotesDelete{NotesDelete: &v1.NotesDelete{RoomId: roomID.String()}}})
	httpx.NoContent(w)
	return nil
}
