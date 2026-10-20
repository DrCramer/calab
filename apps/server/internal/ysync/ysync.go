// Package ysync is the server side of the Yjs sync socket shared by the Wiki (ADR-0096 §4) and
// the Canvas (ADR-0113 §3): GET /api/<section>/.../sync. The server never parses a Yjs document;
// it stores the last snapshot plus the updates after it and relays frames between the sockets of
// one document, on this instance directly and across instances through the Redis channel
// <name>:<docId>.
//
// What a section supplies is a Backend: its storage (Store), the access rule of a socket
// (Authorize) and what a posted snapshot also changes (PostSnapshot: the text for search, the
// title, versions). Everything else lives here: the frames, the in-band authentication, the
// room and its Redis subscription, the catch-up from the database, the per-socket limits, the
// compaction request and the access recheck.
//
// Binary frames, the first byte is the type, integers big-endian:
//
//	0 SNAPSHOT        server → client  0 | u64 through_seq | state
//	1 UPDATE          both ways        1 | u64 seq | update (client → server: seq ignored, 0)
//	2 AWARENESS       both ways        2 | awareness update (relayed, never stored)
//	3 COMPACT_REQUEST server → client  3
//	4 SNAPSHOT_POST   client → server  4 | u64 through_seq | u32 meta_len | meta JSON | state
//
// A stored SNAPSHOT_POST is a silent compaction (no frame back), unless the meta carries
// broadcast: true — the post carries an edit no UPDATE carried (one transaction too big for a
// frame), and its state then goes as a SNAPSHOT to every other socket of the document. A stale
// broadcast post is still relayed (through_seq 0, not stored) and the poster gets a
// COMPACT_REQUEST to persist it with a newer through_seq.
//
// Hard ceiling: when the updates after the snapshot reach Config.CeilingUpdates (10 000) or
// CeilingBytes (16 MiB) the server stops storing UPDATEs of the document (they are dropped, not
// relayed) and sends COMPACT_REQUEST to every socket with WRITE; the first SNAPSHOT_POST that
// absorbs enough of the updates lifts it. A socket that keeps sending for CeilingGrace (10 s) after
// its first refused UPDATE is closed with 4012 (CloseCeiling).
//
// The client's first message is a text frame with its access token (like the gateway's
// IDENTIFY) — a person's access token or a bot token. The server then sends one SNAPSHOT
// (through_seq 0 and the empty Yjs update 0x00 0x00 for a document without one) and every
// UPDATE after it, then relays.
//
// A viewer socket (Hub.ServeViewer, the Canvas's public link, ADR-0114 wave 5) is anonymous and
// receive-only: no token frame — the section resolved the credential (the link code) before the
// upgrade and gives a Viewer with its access rule and its socket limits. It gets the SNAPSHOT,
// the UPDATEs and relayed SNAPSHOTs like a read-only socket, never AWARENESS (who is on the
// document stays hidden) nor COMPACT_REQUEST; any data frame from it closes it with 4013
// (CloseReceiveOnly) and changes nothing. Its access is rechecked like any socket's (Kick, every
// RecheckInterval) and also when the Viewer's access ends by itself (an expiry); it lives at most
// Config.ViewerMaxLife.
package ysync

import (
	"context"
	"encoding/binary"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
)

// Frame types.
const (
	FrameSnapshot     byte = 0
	FrameUpdate       byte = 1
	FrameAwareness    byte = 2
	FrameCompact      byte = 3
	FrameSnapshotPost byte = 4
	// ctlRecheck travels only between instances (Redis): every socket of the document checks its
	// access again now (trash, overrides, restricted).
	ctlRecheck byte = 0xF0
)

// Limits of the protocol (ADR-0096 §4, ADR-0113 §3). MaxState is per section (Backend.MaxState).
const (
	MaxUpdate   = 64 << 10 // bytes of one Yjs update (and of one awareness update)
	MaxMeta     = 1 << 20  // bytes of a snapshot's meta JSON (plain_text ≤ 256 KiB, escaped)
	headerSeq   = 9        // type + u64
	headerPost  = 13       // type + u64 + u32
	readLimitRO = MaxUpdate + 16
)

// Close codes of the sync socket.
const (
	CloseTryAgain  = 4000 // a dependency failed: reconnect
	CloseBadFrame  = 4002 // malformed or unexpected frame
	CloseForbidden = 4003 // no VIEW or not a member, the access policy, a write without WRITE
	CloseAuth      = 4004 // the token is invalid or expired: refresh it
	CloseRate      = 4008 // too many frames, or > MaxConnsPerUser sockets on the document
	CloseIdle      = 4009 // no pong
	CloseRevoked   = 4010 // the session was revoked
	CloseCeiling   = 4012 // kept sending UPDATEs past the document's ceiling without compacting it
	// CloseReceiveOnly: a viewer socket (an anonymous public link) sent a data frame; nothing of
	// it was read into the document. The client must not reconnect in a loop: it is a bug or an
	// attack.
	CloseReceiveOnly = 4013
	CloseNotFound    = 4404 // no such document, or it is in the trash
)

// EmptyState is the Yjs update of an empty document (Y.encodeStateAsUpdate(new Y.Doc())).
var EmptyState = []byte{0, 0}

// ErrGone is what a Backend returns when the document is gone or in the trash: the socket closes
// with CloseNotFound.
var ErrGone = errors.New("ysync: the document is gone or in the trash")

// ErrBadMeta is what a Backend returns for a snapshot meta it cannot read: CloseBadFrame.
var ErrBadMeta = errors.New("ysync: bad snapshot meta")

// Config tunes the sync socket; the zero value is production (tests shorten it).
type Config struct {
	AuthTimeout        time.Duration // the token frame must come within it (10 s)
	SubscribeTimeout   time.Duration // the document's Redis subscription must be confirmed within it (5 s)
	PingInterval       time.Duration // WebSocket ping (25 s)
	IdleTimeout        time.Duration // no pong for this long closes 4009 (60 s)
	RecheckInterval    time.Duration // access and session recheck (30 s)
	UpdatesPerSecond   int           // inbound UPDATE frames per socket (20, over: close 4008)
	AwarenessPerSecond int           // inbound AWARENESS per socket (10, over: dropped)
	SnapshotEvery      time.Duration // inbound SNAPSHOT_POST per socket: 2 at once, then one per (2 s; over: close 4008)
	MaxConnsPerUser    int           // sockets of one person on one document (10)
	CompactUpdates     int           // COMPACT_REQUEST when more updates follow the snapshot (500)
	CompactBytes       int64         // … or more bytes (1 MiB)
	CompactCooldown    time.Duration // at most one COMPACT_REQUEST per document per (10 s)
	CeilingUpdates     int           // hard ceiling: updates stored after the snapshot (10 000)
	CeilingBytes       int64         // … or their bytes (16 MiB): over it an UPDATE is refused (see conn.admitUpdate)
	CeilingGrace       time.Duration // a socket still sending past the ceiling this long after its first refused UPDATE is closed 4012 (10 s)
	CompactCheckEvery  time.Duration // the threshold query at most this often per document (2 s; < 0 = always)
	VersionEvery       time.Duration // a version at most this often per document (the Backend's default if 0)
	WriteTimeout       time.Duration // one frame to the client (10 s)
	ViewerMaxLife      time.Duration // a viewer socket is closed 4000 (reconnect) after this long (2 h)
}

// WithDefaults fills the zero fields with the production values. VersionEvery is not defaulted
// here: how often versions are written differs per section (Backend.PostSnapshot reads it).
func (c Config) WithDefaults() Config {
	def := func(v *time.Duration, d time.Duration) {
		if *v == 0 {
			*v = d
		}
	}
	def(&c.AuthTimeout, 10*time.Second)
	def(&c.SubscribeTimeout, 5*time.Second)
	def(&c.PingInterval, 25*time.Second)
	def(&c.IdleTimeout, 60*time.Second)
	def(&c.RecheckInterval, 30*time.Second)
	def(&c.CompactCooldown, 10*time.Second)
	def(&c.SnapshotEvery, 2*time.Second)
	def(&c.CompactCheckEvery, 2*time.Second)
	def(&c.WriteTimeout, 10*time.Second)
	if c.UpdatesPerSecond == 0 {
		c.UpdatesPerSecond = 20
	}
	if c.AwarenessPerSecond == 0 {
		c.AwarenessPerSecond = 10
	}
	if c.MaxConnsPerUser == 0 {
		c.MaxConnsPerUser = 10
	}
	if c.CompactUpdates == 0 {
		c.CompactUpdates = 500
	}
	if c.CompactBytes == 0 {
		c.CompactBytes = 1 << 20
	}
	if c.CeilingUpdates == 0 {
		c.CeilingUpdates = 10_000
	}
	if c.CeilingBytes == 0 {
		c.CeilingBytes = 16 << 20
	}
	def(&c.CeilingGrace, 10*time.Second)
	def(&c.ViewerMaxLife, 2*time.Hour)
	return c
}

// Viewer is an anonymous receive-only socket on a document (Hub.ServeViewer): the section has
// resolved its credential before the upgrade.
type Viewer struct {
	Doc uuid.UUID
	// Check is the access rule, at connect and on every recheck: code 0 = allowed, else the close
	// code and its reason; until is when the access ends by itself (an expiry; zero = never), the
	// socket checks again then. The context carries a deadline.
	Check func(ctx context.Context) (until time.Time, code int, reason string)
	// Slots are the socket sets the viewer counts in, across instances (per link, per client IP):
	// over any Max the socket is closed 4008 before the snapshot.
	Slots []Slot
}

// Slot is one socket set of a viewer: Key under <name>:viewers:, at most Max sockets.
type Slot struct {
	Key string
	Max int
}

// Authenticator is what the socket needs of auth.Service: the gateway's token check, the
// session recheck and the workspace access policy of the REST identity gate.
type Authenticator interface {
	AuthenticateToken(ctx context.Context, tok string) (auth.Identity, error)
	CheckSession(ctx context.Context, sid uuid.UUID) error
	CheckWorkspace(ctx context.Context, id auth.Identity, ws uuid.UUID, op identitypolicy.Operation) error
	WithPolicy(ctx context.Context, id auth.Identity, op identitypolicy.Operation) context.Context
}

// Update is one stored Yjs update.
type Update struct {
	Seq  int64
	Data []byte
}

// Stats is what is stored after a snapshot: the compaction thresholds and the authors since.
type Stats struct {
	Updates int32
	Bytes   int64
	Authors []uuid.UUID
}

// Store is a section's storage of a document's snapshot and updates. Every method runs through
// the given queries (a transaction or the pool) and returns the generated queries' errors as
// they are (db.IsNotFound is the absence of a snapshot, or of a live document for Append).
type Store interface {
	// GetSnapshot is the snapshot's through_seq and state.
	GetSnapshot(ctx context.Context, q *sqlc.Queries, doc uuid.UUID) (int64, []byte, error)
	// GetSnapshotSeq is the through_seq alone.
	GetSnapshotSeq(ctx context.Context, q *sqlc.Queries, doc uuid.UUID) (int64, error)
	// ListUpdates are at most lim updates after seq after, in order.
	ListUpdates(ctx context.Context, q *sqlc.Queries, doc uuid.UUID, after int64, lim int32) ([]Update, error)
	// AppendUpdate stores an update of a live document under its next seq; db.IsNotFound when
	// the document is gone, in the trash or not a document.
	AppendUpdate(ctx context.Context, q *sqlc.Queries, doc uuid.UUID, data []byte, author *uuid.UUID) (int64, error)
	// UpdatesSince counts the updates and bytes stored after seq after, and their authors.
	UpdatesSince(ctx context.Context, q *sqlc.Queries, doc uuid.UUID, after int64) (Stats, error)
	// UpsertSnapshot saves a snapshot unless a newer one is stored; 0 rows = stale.
	UpsertSnapshot(ctx context.Context, q *sqlc.Queries, doc uuid.UUID, state []byte, through int64, by *uuid.UUID) (int64, error)
	// DeleteUpdatesThrough drops the updates a snapshot contains.
	DeleteUpdatesThrough(ctx context.Context, q *sqlc.Queries, doc uuid.UUID, through int64) error
}

// Post is a SNAPSHOT_POST the socket accepted for storing.
type Post struct {
	Doc     uuid.UUID
	Through int64
	Meta    any // what Backend.DecodeMeta returned
	State   []byte
	By      uuid.UUID
	// VersionEvery is Config.VersionEvery (0 = the section's own default).
	VersionEvery time.Duration
}

// Result is what a Backend did with a Post.
type Result struct {
	// Stored: the snapshot was saved (not stale).
	Stored bool
	// After runs once the post is committed and answered (events about a renamed document).
	After func()
}

// Backend is a section's side of the socket.
type Backend interface {
	Store
	// Name prefixes the Redis keys and channels ("wiki" → wiki:<id>) and the log lines.
	Name() string
	// MaxState is the largest snapshot state in bytes; a larger post is dropped.
	MaxState() int
	// Authorize resolves the identity's access to the document (at connect, and on every
	// recheck): code 0 = allowed (write: may send UPDATE / SNAPSHOT_POST), else the close code
	// and its reason. The context carries a deadline.
	Authorize(ctx context.Context, id auth.Identity, doc uuid.UUID) (write bool, code int, reason string)
	// DecodeMeta reads the JSON of a SNAPSHOT_POST (an error closes the socket with
	// CloseBadFrame). broadcast: the state holds an edit no UPDATE carried.
	DecodeMeta(raw []byte) (meta any, broadcast bool, err error)
	// PostSnapshot stores the post and what goes with it in one transaction: it locks the
	// document row (ErrGone when gone or in the trash), checks the post is not stale with
	// StoreSnapshot, then writes the section's own columns (text, size, title, a version).
	PostSnapshot(ctx context.Context, p Post) (Result, error)
}

// ---- frames ----

func seqFrame(t byte, seq int64, body []byte) []byte {
	out := make([]byte, headerSeq+len(body))
	out[0] = t
	binary.BigEndian.PutUint64(out[1:9], uint64(max(seq, 0))) //nolint:gosec // non-negative
	copy(out[headerSeq:], body)
	return out
}

// SnapshotFrame is a SNAPSHOT frame.
func SnapshotFrame(through int64, state []byte) []byte {
	return seqFrame(FrameSnapshot, through, state)
}

// UpdateFrame is an UPDATE frame.
func UpdateFrame(seq int64, data []byte) []byte { return seqFrame(FrameUpdate, seq, data) }

// FrameSeq is the seq / through_seq of a SNAPSHOT or UPDATE frame.
func FrameSeq(f []byte) int64 {
	if len(f) < headerSeq {
		return 0
	}
	return int64(binary.BigEndian.Uint64(f[1:9])) //nolint:gosec // ≤ 2^63 in practice
}

// ---- storage helpers ----

// LoadSnapshot is the document's snapshot (through_seq 0 and the empty document when none).
func LoadSnapshot(ctx context.Context, st Store, q *sqlc.Queries, doc uuid.UUID) (int64, []byte, error) {
	through, state, err := st.GetSnapshot(ctx, q, doc)
	if db.IsNotFound(err) {
		return 0, EmptyState, nil
	}
	if err != nil {
		return 0, nil, err
	}
	return through, state, nil
}

// SnapshotSeq is the through_seq of the document's snapshot (0 when none).
func SnapshotSeq(ctx context.Context, st Store, q *sqlc.Queries, doc uuid.UUID) (int64, error) {
	seq, err := st.GetSnapshotSeq(ctx, q, doc)
	if db.IsNotFound(err) {
		return 0, nil
	}
	return seq, err
}

// EachUpdate calls fn for every stored update after seq after, in order.
func EachUpdate(ctx context.Context, st Store, q *sqlc.Queries, doc uuid.UUID, after int64, fn func(seq int64, data []byte) error) error {
	const batch = 500
	for {
		rows, err := st.ListUpdates(ctx, q, doc, after, batch)
		if err != nil {
			return err
		}
		for _, u := range rows {
			if err := fn(u.Seq, u.Data); err != nil {
				return err
			}
			after = u.Seq
		}
		if len(rows) < batch {
			return nil
		}
	}
}

// StoreSnapshot is the generic part of a Backend.PostSnapshot, inside its transaction and under
// the document row lock: it ignores a stale post (through below the stored snapshot, or past the
// counter nextSeq - 1), saves the snapshot and drops the updates it contains. authors are those
// of the updates the snapshot absorbed; stored is false for a stale post.
func StoreSnapshot(ctx context.Context, st Store, q *sqlc.Queries, doc uuid.UUID, nextSeq, through int64, state []byte, by *uuid.UUID) (stored bool, authors []uuid.UUID, err error) {
	prev, err := SnapshotSeq(ctx, st, q, doc)
	if err != nil {
		return false, nil, err
	}
	if through < prev || through > nextSeq-1 {
		return false, nil, nil // stale (or ahead of the counter): ignored
	}
	since, err := st.UpdatesSince(ctx, q, doc, prev)
	if err != nil {
		return false, nil, err
	}
	n, err := st.UpsertSnapshot(ctx, q, doc, state, through, by)
	if err != nil || n == 0 {
		return false, nil, err
	}
	if err := st.DeleteUpdatesThrough(ctx, q, doc, through); err != nil {
		return false, nil, err
	}
	return true, since.Authors, nil
}

// IsRefusal reports an API refusal (an identity policy, a suspension), not a dependency failure.
func IsRefusal(err error) bool {
	var e *httpx.Error
	return errors.As(err, &e) && e.Err == nil
}
