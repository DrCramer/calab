package sip

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Caller ID (ADR-0137 §2): who an outside number is — the phone book's contact of the number,
// else the employee of the workspace whose profile phone (ADR-0077) it is, else nobody (the
// number is shown). Names are read when a call is shown, never stored with the call: a contact
// added after a call names it in the journal too.

// Caller is who a number is; the zero value is nobody.
type Caller struct {
	ContactID     *uuid.UUID
	Name, Company string
	UserID        *uuid.UUID
}

// Known reports whether the number is somebody.
func (c Caller) Known() bool { return c.ContactID != nil || c.UserID != nil }

// resolveCallers is the order of the sources for numbers: a contact wins over an employee's
// phone; a phone two employees share names nobody (ambiguous is worse than a number).
func resolveCallers(numbers []string, contacts map[string]Caller, members map[string][]uuid.UUID) map[string]Caller {
	out := make(map[string]Caller, len(numbers))
	for _, n := range numbers {
		if n == "" {
			continue
		}
		if c, ok := contacts[n]; ok && c.ContactID != nil {
			out[n] = c
			continue
		}
		if us := members[n]; len(us) == 1 {
			u := us[0]
			out[n] = Caller{UserID: &u}
		}
	}
	return out
}

// memberPhonesTTL: how long a workspace's snapshot of its people's phones is reused.
const (
	memberPhonesTTL = 60 * time.Second
	memberPhonesMax = 2000 // workspaces cached at once (then the cache starts over)
)

type memberPhones struct {
	at       time.Time
	byNumber map[string][]uuid.UUID
}

// phoneCache: the people's phones per workspace, normalised (ADR-0137: a 60 s snapshot rather
// than a query per call event).
var phoneCache = struct {
	sync.Mutex
	m map[uuid.UUID]memberPhones
}{m: map[uuid.UUID]memberPhones{}}

func memberPhonesOf(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) (map[string][]uuid.UUID, error) {
	now := time.Now()
	phoneCache.Lock()
	if c, ok := phoneCache.m[ws]; ok && now.Sub(c.at) < memberPhonesTTL {
		phoneCache.Unlock()
		return c.byNumber, nil
	}
	phoneCache.Unlock()
	rows, err := q.ListSipMemberPhones(ctx, ws)
	if err != nil {
		return nil, err
	}
	by := map[string][]uuid.UUID{}
	for _, r := range rows {
		if n, ok := NormalizeNumber(r.Phone); ok {
			by[n] = append(by[n], r.ID)
		}
	}
	phoneCache.Lock()
	if len(phoneCache.m) >= memberPhonesMax {
		phoneCache.m = map[uuid.UUID]memberPhones{}
	}
	phoneCache.m[ws] = memberPhones{at: now, byNumber: by}
	phoneCache.Unlock()
	return by, nil
}

// Callers looks the numbers (E.164) up in workspace ws: one query for the contacts, the
// people's phones from the 60 s snapshot. Numbers nobody has are left out.
func Callers(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, numbers []string) (map[string]Caller, error) {
	want := make([]string, 0, len(numbers))
	seen := map[string]bool{}
	for _, n := range numbers {
		if n != "" && !seen[n] && e164.MatchString(n) {
			seen[n] = true
			want = append(want, n)
		}
	}
	if len(want) == 0 {
		return map[string]Caller{}, nil
	}
	owners, err := q.SipContactNumberOwners(ctx, sqlc.SipContactNumberOwnersParams{WorkspaceID: ws, Numbers: want})
	if err != nil {
		return nil, err
	}
	contacts := make(map[string]Caller, len(owners))
	for _, o := range owners {
		id := o.ID
		contacts[o.Number] = Caller{ContactID: &id, Name: o.Name, Company: o.Company}
	}
	members, err := memberPhonesOf(ctx, q, ws)
	if err != nil {
		return nil, err
	}
	return resolveCallers(want, contacts, members), nil
}

// callerOf is who number is in workspace ws (nobody when the lookup fails: a call is never
// held up by its caller ID).
func (s *Service) callerOf(ctx context.Context, ws uuid.UUID, number string) Caller {
	if number == "" {
		return Caller{}
	}
	m, err := Callers(ctx, s.db.Q, ws, []string{number})
	if err != nil {
		slog.WarnContext(ctx, "sip: caller ID", "workspace", ws, "err", err)
		return Caller{}
	}
	return m[number]
}

// FillCaller sets the caller ID fields of a call (inbound: who calls; personal: who is called).
func FillCaller(pb *v1.SipCall, c Caller) *v1.SipCall {
	pb.CallerName, pb.CallerCompany = c.Name, c.Company
	pb.ContactId, pb.CallerUserId = idString(c.ContactID), idString(c.UserID)
	return pb
}

// FillCallers sets the caller ID of inbound and personal calls of workspace ws in place (room
// calls and tests are left as they are): WorkspaceSnapshot.sip_calls.
func FillCallers(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, calls []*v1.SipCall) error {
	var numbers []string
	for _, c := range calls {
		if callerShown(c) {
			numbers = append(numbers, c.GetNumber())
		}
	}
	if len(numbers) == 0 {
		return nil
	}
	m, err := Callers(ctx, q, ws, numbers)
	if err != nil {
		return err
	}
	for _, c := range calls {
		if callerShown(c) {
			FillCaller(c, m[c.GetNumber()])
		}
	}
	return nil
}

// callerShown: caller ID is for the people a call concerns personally — inbound calls and
// personal calls; a room's call goes to everybody who sees the room (guests too) and stays a
// number.
func callerShown(c *v1.SipCall) bool {
	return c.GetDirection() == v1.SipCallDirection_SIP_CALL_DIRECTION_IN || c.GetOrigin() == v1.SipCallOrigin_SIP_CALL_ORIGIN_PERSONAL
}

// botsAmong returns which of users are bots, read only when caller ID names an employee: a bot
// never learns whose phone a number is (contacts are never in the Bot API, ADR-0077).
func (s *Service) botsAmong(ctx context.Context, pb *v1.SipCall, users []uuid.UUID) map[uuid.UUID]bool {
	out := map[uuid.UUID]bool{}
	if pb.GetCallerUserId() == "" || len(users) == 0 {
		return out
	}
	ids, err := s.db.Q.ListBotUsers(ctx, users)
	if err != nil {
		// Unknown: treat everybody as a bot rather than tell one.
		for _, u := range users {
			out[u] = true
		}
		return out
	}
	for _, id := range ids {
		out[id] = true
	}
	return out
}

// forBot is pb without the employee caller ID (a copy).
func forBot(pb *v1.SipCall) *v1.SipCall {
	if pb.GetCallerUserId() == "" {
		return pb
	}
	c := proto.CloneOf(pb)
	c.CallerUserId = ""
	return c
}
