package sip

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/diskacl"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// The call journal (ADR-0137 §1): writing a call's events and parties with its row, the journal
// API (pages, the detail of a call, «seen»), the live SIP_JOURNAL_ENTRY / SIP_MISSED_CHANGED,
// and the workspace's telephony policy (retention, outbound limits).

// Origins of a call (sip_calls.origin).
const (
	OriginRoom     = "room"
	OriginPersonal = "personal"
	OriginInbound  = "inbound"
	OriginTest     = "test"
)

// Journal pages.
const (
	journalDefault = 50
	journalMax     = 100
)

// ---------------------------------------------------------------- writing

// writeEvents stores evs and the parties they make in the transaction q; an event ENDED of an
// inbound call marks it missed when nobody answered (true: it was marked now).
func writeEvents(ctx context.Context, q *sqlc.Queries, call uuid.UUID, evs []Event) (bool, error) {
	if len(evs) == 0 {
		return false, nil
	}
	raw, err := json.Marshal(evs)
	if err != nil {
		return false, err
	}
	if err := q.InsertSipCallEvents(ctx, sqlc.InsertSipCallEventsParams{CallID: call, Events: raw}); err != nil {
		return false, err
	}
	if ps := Parties(evs); len(ps) > 0 {
		raw, err := json.Marshal(ps)
		if err != nil {
			return false, err
		}
		if err := q.UpsertSipCallParties(ctx, sqlc.UpsertSipCallPartiesParams{CallID: call, Parties: raw}); err != nil {
			return false, err
		}
	}
	if !slices.ContainsFunc(evs, func(ev Event) bool { return ev.Kind == EvEnded }) {
		return false, nil
	}
	n, err := q.MarkSipCallMissed(ctx, call)
	return n > 0, err
}

// journalTx writes a transition of the inbound state machine: update changes the call row (nil:
// none; a row it does not find is no error here — the events are still kept) and evs (numbered
// by the machine) go with it in one transaction. The row's not-found error is returned after.
func (s *Service) journalTx(ctx context.Context, call uuid.UUID, evs []Event, update func(q *sqlc.Queries) (sqlc.SipCall, error)) (sqlc.SipCall, error) {
	var row sqlc.SipCall
	var upErr error
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if update != nil {
			row, upErr = update(q)
			if upErr != nil && !db.IsNotFound(upErr) {
				return upErr
			}
		}
		missed, err := writeEvents(ctx, q, call, evs)
		row.Missed = row.Missed || missed
		return err
	})
	if err != nil {
		return row, err
	}
	return row, upErr
}

// journalOutside writes events from outside the inbound state machine (outbound calls, the
// recording, refused and lost inbound calls): update (nil: none) changes the call row in the
// same transaction — a row it does not find writes nothing — and evs take the numbers after the
// last stored one (inbound calls: past seqOutside). With an update, SIP_JOURNAL_ENTRY follows.
func (s *Service) journalOutside(ctx context.Context, call uuid.UUID, update func(q *sqlc.Queries) (sqlc.SipCall, error), evs ...Event) (sqlc.SipCall, error) {
	var row sqlc.SipCall
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if update != nil {
			var err error
			if row, err = update(q); err != nil {
				return err
			}
		}
		lk, err := q.LockSipCallJournal(ctx, call)
		if err != nil {
			return err
		}
		next := int(lk.LastSeq)
		if lk.Direction == "in" && next < seqOutside {
			next = seqOutside
		}
		now := time.Now()
		for i := range evs {
			next++
			evs[i].Seq = next
			if evs[i].At.IsZero() {
				evs[i].At = now
			}
			evs[i] = evs[i].clean()
		}
		missed, err := writeEvents(ctx, q, call, evs)
		row.Missed = row.Missed || missed
		return err
	})
	if err == nil && update != nil {
		s.journalChanged(context.WithoutCancel(ctx), row, evs)
	}
	return row, err
}

// RecordingEvent journals the recording of a call (ADR-0131): status "started", "stored" or
// "failed" (recording.JournalSink).
func (s *Service) RecordingEvent(ctx context.Context, call uuid.UUID, status string) {
	// The recorder works in the background of the request that connected the call: its own
	// bookkeeping, outside that request's admission (which allows one transaction at a time).
	ctx = db.WithoutAdmission(context.WithoutCancel(ctx))
	if _, err := s.journalOutside(ctx, call, nil, Event{Kind: EvRecording, Reason: status}); err != nil && !db.IsNotFound(err) {
		slog.WarnContext(ctx, "sip: journal the recording", "call", call, "status", status, "err", err)
	}
}

// journalChanged announces a call that appeared, was answered or transferred, or ended
// (SIP_JOURNAL_ENTRY), and the missed badges of the people a missed call rang.
func (s *Service) journalChanged(ctx context.Context, row sqlc.SipCall, evs []Event) {
	if row.ID == uuid.Nil {
		return
	}
	announce, ended := false, false
	for _, ev := range evs {
		switch ev.Kind {
		case EvStarted, EvAnswered, EvTransfer, EvTransferEnd:
			announce = true
		case EvEnded:
			announce, ended = true, true
		}
	}
	if !announce {
		return
	}
	entries, err := s.entries(ctx, []sqlc.SipCall{row})
	if err != nil || len(entries) == 0 {
		slog.WarnContext(ctx, "sip: journal entry", "call", row.ID, "err", err)
		return
	}
	s.events.Workspace(ctx, row.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_SipJournalEntry{
		SipJournalEntry: &v1.SipJournalChange{Entry: entries[0]}}})
	if !ended || !row.Missed {
		return
	}
	for _, p := range entries[0].GetParties() {
		if u, err := uuid.Parse(p.GetUserId()); err == nil && p.GetRang() {
			s.missedChanged(ctx, row.WorkspaceID, u)
		}
	}
}

// missedChanged sends the member's missed badge of the workspace to their devices.
func (s *Service) missedChanged(ctx context.Context, ws, user uuid.UUID) {
	n, err := s.db.Q.CountSipMissed(ctx, sqlc.CountSipMissedParams{WorkspaceID: ws, UserID: user})
	if err != nil {
		slog.WarnContext(ctx, "sip: count missed calls", "workspace", ws, "user", user, "err", err)
		return
	}
	s.events.User(ctx, user, &v1.DispatchEvent{Event: &v1.DispatchEvent_SipMissedChanged{
		SipMissedChanged: &v1.SipMissedChanged{WorkspaceId: ws.String(), Count: uint32(max(n, 0))}}}) //nolint:gosec // ≤ 999
}

// ---------------------------------------------------------------- reading

var originPB = map[string]v1.SipCallOrigin{
	OriginRoom: v1.SipCallOrigin_SIP_CALL_ORIGIN_ROOM, OriginPersonal: v1.SipCallOrigin_SIP_CALL_ORIGIN_PERSONAL,
	OriginInbound: v1.SipCallOrigin_SIP_CALL_ORIGIN_INBOUND, OriginTest: v1.SipCallOrigin_SIP_CALL_ORIGIN_TEST,
}

var eventKindPB = map[EventKind]v1.SipCallEventKind{
	EvStarted: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_STARTED, EvMenu: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_MENU,
	EvKey: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_KEY, EvDialed: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_DIALED,
	EvNoInput: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_NO_INPUT, EvNotice: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_NOTICE,
	EvGroup: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_GROUP, EvRing: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_RING,
	EvRingEnd: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_RING_END, EvFallback: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_FALLBACK,
	EvAnswered: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_ANSWERED, EvTransfer: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_TRANSFER,
	EvTransferEnd: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_TRANSFER_END, EvDialing: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_DIALING,
	EvProviderRinging: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_PROVIDER_RINGING,
	EvRecording:       v1.SipCallEventKind_SIP_CALL_EVENT_KIND_RECORDING, EvEnded: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_ENDED,
	EvSchedule: v1.SipCallEventKind_SIP_CALL_EVENT_KIND_SCHEDULE,
}

var targetKindPB = map[TargetKind]v1.SipCallTargetKind{
	TkMenu: v1.SipCallTargetKind_SIP_CALL_TARGET_KIND_MENU, TkGroup: v1.SipCallTargetKind_SIP_CALL_TARGET_KIND_GROUP,
	TkExtension: v1.SipCallTargetKind_SIP_CALL_TARGET_KIND_EXTENSION, TkUser: v1.SipCallTargetKind_SIP_CALL_TARGET_KIND_USER,
	TkRoom: v1.SipCallTargetKind_SIP_CALL_TARGET_KIND_ROOM,
}

func idString(u *uuid.UUID) string {
	if u == nil {
		return ""
	}
	return u.String()
}

func msBetween(a time.Time, b *time.Time) uint32 {
	if b == nil || b.Before(a) {
		return 0
	}
	return uint32(min(b.Sub(a).Milliseconds(), int64(^uint32(0)))) //nolint:gosec // clamped
}

// entryPB is a call's journal row.
func entryPB(c sqlc.SipCall, parties []sqlc.SipCallParty, hasEvents bool) *v1.SipJournalEntry {
	out := &v1.SipJournalEntry{Call: pbconv.SipCall(c), Origin: originPB[c.Origin], PeerE164: c.PeerE164, Missed: c.Missed,
		HasEvents: hasEvents, Parties: make([]*v1.SipCallParty, 0, len(parties))}
	switch {
	case c.AnsweredAt != nil:
		out.WaitMs = msBetween(c.StartedAt, c.AnsweredAt)
		out.TalkMs = msBetween(*c.AnsweredAt, c.EndedAt)
	case c.EndedAt != nil:
		out.WaitMs = msBetween(c.StartedAt, c.EndedAt)
	}
	for _, p := range parties {
		out.Parties = append(out.Parties, &v1.SipCallParty{UserId: p.UserID.String(), Placed: p.Placed, Rang: p.Rang,
			Answered: p.Answered, Transferred: p.Transferred})
	}
	return out
}

// entries are the journal rows of calls: their parties and whether they have events, two
// queries for the page.
func (s *Service) entries(ctx context.Context, calls []sqlc.SipCall) ([]*v1.SipJournalEntry, error) {
	ids := make([]uuid.UUID, len(calls))
	for i, c := range calls {
		ids[i] = c.ID
	}
	parties, err := s.db.Q.ListSipCallParties(ctx, ids)
	if err != nil {
		return nil, err
	}
	withEvents, err := s.db.Q.SipCallsWithEvents(ctx, ids)
	if err != nil {
		return nil, err
	}
	byCall := map[uuid.UUID][]sqlc.SipCallParty{}
	for _, p := range parties {
		byCall[p.CallID] = append(byCall[p.CallID], p)
	}
	// Names as of now (ADR-0137 §2): one lookup for the page's numbers.
	numbers := make([]string, 0, len(calls))
	for _, c := range calls {
		if c.PeerE164 != "" && c.Origin != OriginTest {
			numbers = append(numbers, c.PeerE164)
		}
	}
	callers := map[string]Caller{}
	if len(numbers) > 0 && len(calls) > 0 {
		if callers, err = Callers(ctx, s.db.Q, calls[0].WorkspaceID, numbers); err != nil {
			return nil, err
		}
	}
	out := make([]*v1.SipJournalEntry, len(calls))
	for i, c := range calls {
		out[i] = entryPB(c, byCall[c.ID], slices.Contains(withEvents, c.ID))
		if c.Origin == OriginTest {
			continue
		}
		if who := callers[c.PeerE164]; who.ContactID != nil {
			out[i].Contact = &v1.SipContactRef{Id: who.ContactID.String(), Name: who.Name, Company: who.Company}
		} else if who.UserID != nil {
			out[i].MemberUserId = who.UserID.String()
		}
	}
	return out, nil
}

// hideMembers drops the employee caller ID of entries a bot reads: a bot never learns whose
// phone a number is (ADR-0077).
func hideMembers(entries []*v1.SipJournalEntry) {
	for _, e := range entries {
		e.MemberUserId = ""
	}
}

func eventPB(ev Event) *v1.SipCallEvent {
	out := &v1.SipCallEvent{Seq: uint32(max(ev.Seq, 0)), Kind: eventKindPB[ev.Kind], UserId: idString(ev.User), //nolint:gosec // a count
		PeerUserId: idString(ev.Peer), TargetKind: targetKindPB[ev.TargetKind], TargetId: idString(ev.TargetID),
		TargetName: ev.TargetName, Digits: ev.Digits, Reason: ev.Reason}
	if !ev.At.IsZero() {
		out.At = timestamppb.New(ev.At)
	}
	return out
}

func eventOf(e sqlc.SipCallEvent) Event {
	return Event{Seq: int(e.Seq), At: e.At, Kind: EventKind(e.Kind), User: e.UserID, Peer: e.PeerUserID,
		TargetKind: TargetKind(e.TargetKind), TargetID: e.TargetID, TargetName: e.TargetName, Digits: e.Digits, Reason: e.Reason}
}

// ---------------------------------------------------------------- the API

func (s *Service) journalRoutes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/workspaces/{id}/sip/journal", wrap(httpx.HandlerFunc(s.listJournal)))
	mux.Handle("GET /api/workspaces/{id}/sip/journal/{cid}", wrap(httpx.HandlerFunc(s.journalEntry)))
	mux.Handle("POST /api/workspaces/{id}/sip/journal/seen", wrap(httpx.HandlerFunc(s.journalSeen)))
}

// journalReader resolves the workspace of the path for a member who is not a guest (404 for
// non-members, 403 for guests) with their bits.
func journalReader(r *http.Request) (uuid.UUID, perm.Bits, error) {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return uuid.Nil, 0, err
	}
	bits, role, err := perm.FromContext(r.Context()).Workspace(r.Context(), wsID, uid(r))
	if errors.Is(err, perm.ErrNotMember) {
		return uuid.Nil, 0, httpx.NotFound("workspace")
	}
	if err != nil {
		return uuid.Nil, 0, err
	}
	if role == perm.RoleGuest {
		return uuid.Nil, 0, httpx.Forbidden("guests have no call journal")
	}
	return wsID, bits, nil
}

// roomVisible: a call of a room is in the workspace-wide journal for those who can view the room
// (a call without a room — inbound, personal, a test, a deleted room — for everybody).
func roomVisible(ctx context.Context, res *perm.Resolver, room *uuid.UUID, user uuid.UUID) (bool, error) {
	if room == nil {
		return true, nil
	}
	acc, err := res.ReadRoom(ctx, *room, user)
	if errors.Is(err, perm.ErrNoRoom) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return acc.Bits.Has(perm.ViewRoom), nil
}

// journalCursor is the page key «<started_at unix µs>.<id>».
func journalCursor(c sqlc.SipCall) string {
	return strconv.FormatInt(c.StartedAt.UnixMicro(), 10) + "." + c.ID.String()
}

func parseJournalCursor(v string) (*time.Time, *uuid.UUID, bool) {
	at, id, ok := strings.Cut(v, ".")
	if !ok {
		return nil, nil, false
	}
	us, err := strconv.ParseInt(at, 10, 64)
	if err != nil {
		return nil, nil, false
	}
	u, err := uuid.Parse(id)
	if err != nil {
		return nil, nil, false
	}
	t := time.UnixMicro(us)
	return &t, &u, true
}

// journalQuery is a validated GET …/sip/journal.
type journalQuery struct {
	all       bool
	user      *uuid.UUID
	direction string
	missed    bool
	digits    string
	text      string
	byPeers   bool
	from, to  *time.Time
	cursorAt  *time.Time
	cursorID  *uuid.UUID
	limit     int
}

func parseJournalQuery(r *http.Request, bits perm.Bits) (journalQuery, error) {
	qv := r.URL.Query()
	out := journalQuery{limit: journalDefault}
	switch qv.Get("scope") {
	case "", "mine":
	case "all":
		if !bits.Has(perm.ViewJournals) {
			return out, httpx.Forbidden("VIEW_JOURNALS required for all calls")
		}
		out.all = true
	default:
		return out, httpx.Validation("scope", "scope is mine or all")
	}
	switch qv.Get("filter") {
	case "":
	case "missed":
		out.missed = true
	case "in", "out":
		out.direction = qv.Get("filter")
	default:
		return out, httpx.Validation("filter", "filter is missed, in or out")
	}
	if v := qv.Get("user"); v != "" {
		if !out.all {
			return out, httpx.Validation("user", "user needs scope=all")
		}
		u, err := uuid.Parse(v)
		if err != nil {
			return out, httpx.Validation("user", "user is a user id")
		}
		out.user = &u
	}
	if q := strings.TrimSpace(qv.Get("q")); q != "" {
		var b strings.Builder
		for _, r := range q {
			if r >= '0' && r <= '9' && b.Len() < 16 {
				b.WriteRune(r)
			}
		}
		out.digits = b.String()
		// A text without digits looks contacts up by name or company (ADR-0137 §2): their
		// numbers are the peers.
		if out.byPeers = out.digits == ""; out.byPeers {
			out.text = clip(q, 64)
		}
	}
	for _, f := range []struct {
		name string
		dst  **time.Time
	}{{"from", &out.from}, {"to", &out.to}} {
		if v := qv.Get(f.name); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				return out, httpx.Validation(f.name, f.name+" must be an RFC 3339 time")
			}
			*f.dst = &t
		}
	}
	if v := qv.Get("cursor"); v != "" {
		var ok bool
		if out.cursorAt, out.cursorID, ok = parseJournalCursor(v); !ok {
			return out, httpx.Validation("cursor", "bad cursor")
		}
	}
	if v := qv.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > journalMax {
			return out, httpx.Validation("limit", "limit is 1 to 100")
		}
		out.limit = n
	}
	return out, nil
}

// listJournal: GET /api/workspaces/{id}/sip/journal (sip.proto).
func (s *Service) listJournal(w http.ResponseWriter, r *http.Request) error {
	wsID, bits, err := journalReader(r)
	if err != nil {
		return err
	}
	jq, err := parseJournalQuery(r, bits)
	if err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	lim := int32(jq.limit + 1) //nolint:gosec // ≤ 101
	var rows []sqlc.SipCall
	user := &me
	if jq.all {
		user = jq.user
	}
	peers := []string{}
	if jq.byPeers {
		if peers, err = s.db.Q.SipContactNumbersByText(ctx, sqlc.SipContactNumbersByTextParams{WorkspaceID: wsID, Text: jq.text}); err != nil {
			return err
		}
	}
	if user != nil {
		rows, err = s.db.Q.ListSipJournalForUser(ctx, sqlc.ListSipJournalForUserParams{WorkspaceID: wsID, UserID: *user,
			Direction: jq.direction, Missed: jq.missed, Digits: jq.digits, ByPeers: jq.byPeers, Peers: peers,
			From: jq.from, To: jq.to, CursorAt: jq.cursorAt, CursorID: jq.cursorID, Lim: lim})
	} else {
		rows, err = s.db.Q.ListSipJournal(ctx, sqlc.ListSipJournalParams{WorkspaceID: wsID,
			Direction: jq.direction, Missed: jq.missed, Digits: jq.digits, ByPeers: jq.byPeers, Peers: peers,
			From: jq.from, To: jq.to, CursorAt: jq.cursorAt, CursorID: jq.cursorID, Lim: lim})
	}
	if err != nil {
		return err
	}
	out := &v1.ListSipJournalResponse{Entries: []*v1.SipJournalEntry{}}
	if len(rows) > jq.limit {
		rows = rows[:jq.limit]
		out.NextCursor = journalCursor(rows[len(rows)-1])
	}
	visible := rows[:0:0]
	if jq.all {
		res := perm.FromContext(ctx)
		for _, c := range rows {
			ok, err := roomVisible(ctx, res, c.RoomID, me)
			if err != nil {
				return err
			}
			if ok {
				visible = append(visible, c)
			}
		}
	} else {
		visible = rows
	}
	if len(visible) > 0 {
		if out.Entries, err = s.entries(ctx, visible); err != nil {
			return err
		}
		if auth.MustFromContext(ctx).IsBot {
			hideMembers(out.Entries)
		}
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// journalEntry: GET /api/workspaces/{id}/sip/journal/{cid} (sip.proto).
func (s *Service) journalEntry(w http.ResponseWriter, r *http.Request) error {
	wsID, bits, err := journalReader(r)
	if err != nil {
		return err
	}
	cid, err := httpx.PathUUID(r, "cid", "call")
	if err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	row, err := s.db.Q.GetSipCall(ctx, cid)
	if db.IsNotFound(err) || (err == nil && row.WorkspaceID != wsID) {
		return httpx.NotFound("call")
	}
	if err != nil {
		return err
	}
	entries, err := s.entries(ctx, []sqlc.SipCall{row})
	if err != nil {
		return err
	}
	entry := entries[0]
	if auth.MustFromContext(ctx).IsBot {
		hideMembers(entries)
	}
	party := slices.ContainsFunc(entry.GetParties(), func(p *v1.SipCallParty) bool { return p.GetUserId() == me.String() })
	if !party {
		ok := bits.Has(perm.ViewJournals)
		if ok {
			if ok, err = roomVisible(ctx, perm.FromContext(ctx), row.RoomID, me); err != nil {
				return err
			}
		}
		if !ok {
			return httpx.NotFound("call")
		}
	}
	out := &v1.GetSipJournalEntryResponse{Entry: entry, Events: []*v1.SipCallEvent{}}
	stored, err := s.db.Q.ListSipCallEvents(ctx, cid)
	if err != nil {
		return err
	}
	evs := make([]Event, 0, len(stored))
	for _, e := range stored {
		evs = append(evs, eventOf(e))
	}
	if len(evs) == 0 { // a call from before the journal: its route, without times
		evs = LegacyEvents(row.Route, row.Reason, row.AnsweredAt != nil, row.AnsweredBy, row.EndedBy, !pbconv.SipCallLive(row.Status))
	}
	for _, ev := range evs {
		out.Events = append(out.Events, eventPB(ev))
	}
	if out.Recording, err = s.recordingFor(ctx, wsID, cid, me); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// recordingFor is the stored recording of a call when the reader may view its Disk file
// (DISK_VIEW, ADR-0094) and it is not in the trash; nil otherwise.
func (s *Service) recordingFor(ctx context.Context, wsID, call, user uuid.UUID) (*v1.SipJournalRecording, error) {
	rec, err := s.db.Q.GetSipCallRecordingByCall(ctx, call)
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if rec.Status != "stored" || rec.DiskItemID == nil || rec.FileID == nil {
		return nil, nil
	}
	m, err := perm.FromContext(ctx).Member(ctx, wsID, user)
	if err != nil {
		return nil, nil //nolint:nilerr // not a member: no recording
	}
	ch, err := diskacl.Load(ctx, s.db.Q, []uuid.UUID{*rec.DiskItemID})
	if err != nil {
		return nil, err
	}
	if !ch.Has(*rec.DiskItemID) || ch.Item(*rec.DiskItemID).TrashedAt != nil || !ch.Bits(m, rec.DiskItemID).Has(perm.DiskView) {
		return nil, nil
	}
	out := &v1.SipJournalRecording{FileId: rec.FileID.String(), DiskItemId: rec.DiskItemID.String()}
	if rec.StoppedAt != nil {
		out.DurationMs = msBetween(rec.StartedAt, rec.StoppedAt)
	}
	return out, nil
}

// journalSeen: POST /api/workspaces/{id}/sip/journal/seen (sip.proto).
func (s *Service) journalSeen(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := journalReader(r)
	if err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	if err := db.GuardExec(ctx, s.db, func(q *sqlc.Queries) error {
		return q.SetSipSeen(ctx, sqlc.SetSipSeenParams{WorkspaceID: wsID, UserID: me})
	}); err != nil {
		return err
	}
	s.missedChanged(context.WithoutCancel(ctx), wsID, me)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// ---------------------------------------------------------------- the policy

// retentionMonths: the periods an admin may choose (owner, 27.10).
var retentionMonths = []int{1, 3, 6, 12, 24, 36}

// DefaultRetentionMonths is the journal's period unless the admin chose another.
const DefaultRetentionMonths = 12

// policyOf is the workspace's policy (the defaults for an account never saved).
func policyOf(a sqlc.SipAccount) (retention, perHour, perUser uint32) {
	retention, perHour, perUser = DefaultRetentionMonths, DefaultOutPerHour, DefaultOutPerUserHour
	if a.RetentionMonths > 0 {
		retention = uint32(a.RetentionMonths) //nolint:gosec // ≤ 36
	}
	if a.OutPerHour > 0 {
		perHour = uint32(a.OutPerHour) //nolint:gosec // ≤ 1000
	}
	if a.OutPerUserHour > 0 {
		perUser = uint32(a.OutPerUserHour) //nolint:gosec // ≤ 1000
	}
	return retention, perHour, perUser
}

// takeOutbound spends one outbound call of the workspace's and the member's hourly limits:
// 429 SIP_RATE_LIMITED with Retry-After when either is used up.
func (s *Service) takeOutbound(ctx context.Context, a sqlc.SipAccount, user uuid.UUID) error {
	_, perHour, perUser := policyOf(a)
	err := s.CallLimit.TakeHourly(ctx, a.WorkspaceID.String(), int(perHour))
	msg := "too many phone calls from this workspace; try again later"
	if err == nil {
		err = s.UserCallLimit.TakeHourly(ctx, a.WorkspaceID.String()+":"+user.String(), int(perUser))
		msg = "too many phone calls from you; try again later"
	}
	if err == nil {
		return nil
	}
	if e := httpx.AsError(err); e.Code == v1.ErrorCode_ERROR_CODE_RATE_LIMITED {
		sipErr := httpx.Coded(http.StatusTooManyRequests, v1.ErrorCode_ERROR_CODE_SIP_RATE_LIMITED, msg)
		sipErr.RetryAfter = e.RetryAfter
		return sipErr
	}
	return err
}

// putPolicy: PUT /api/workspaces/{id}/sip/policy (sip.proto).
func (s *Service) putPolicy(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manage(r)
	if err != nil {
		return err
	}
	if err := s.planAllows(r.Context(), wsID); err != nil {
		return err
	}
	var req v1.PutSipPolicyRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	retention := int(req.GetRetentionMonths())
	if retention == 0 {
		retention = DefaultRetentionMonths
	}
	if !slices.Contains(retentionMonths, retention) {
		return httpx.Validation("retentionMonths", "keep calls 1, 3, 6, 12, 24 or 36 months")
	}
	perHour, perUser := int(req.GetOutPerHour()), int(req.GetOutPerUserHour())
	if perHour == 0 {
		perHour = DefaultOutPerHour
	}
	if perUser == 0 {
		perUser = DefaultOutPerUserHour
	}
	if perHour > 1000 {
		return httpx.Validation("outPerHour", "outbound calls per hour are 1 to 1000")
	}
	if perUser > 1000 {
		return httpx.Validation("outPerUserHour", "outbound calls per member and hour are 1 to 1000")
	}
	ctx := r.Context()
	if _, saved, err := s.account(ctx, s.db.Q, wsID); err != nil {
		return err
	} else if !saved {
		return httpx.Conflict("save the provider settings first")
	}
	a, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.SipAccount, error) {
		return q.SetSipPolicy(ctx, sqlc.SetSipPolicyParams{WorkspaceID: wsID, RetentionMonths: int16(retention), //nolint:gosec // ≤ 36
			OutPerHour: int32(perHour), OutPerUserHour: int32(perUser)}) //nolint:gosec // ≤ 1000
	})
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: policy saved", "workspace", wsID, "by", uid(r), "retention_months", retention,
		"out_per_hour", perHour, "out_per_user_hour", perUser)
	out := settingsPB(a, true)
	out.InboundAvailable = s.inboundReady()
	s.fillRecording(out, a)
	if ex, err := loadExchange(ctx, s.db.Q, wsID); err == nil {
		fillInbound(out, a, ex)
	} else {
		fillInbound(out, a, nil)
	}
	s.fillRegistration(ctx, out, a)
	httpx.Write(w, http.StatusOK, &v1.PutSipPolicyResponse{Settings: out})
	return nil
}
