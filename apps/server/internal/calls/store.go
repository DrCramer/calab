package calls

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Valkey keys (docs/04 «Звонки»; inside the key namespace, redisx.Key):
//
//	call:<id>            string JSON Record, TTL 24 h (renewed on the answer)
//	user_call:<user_id>  string id of the user's RINGING / ACTIVE call (busy check, READY.call)
//	call:oncall:<user_id> string id of the user's ACTIVE call (Presence.on_call)
//	call:ringing         zset   id → ring deadline (unix ms), for the sweeper
//	call:active          zset   id → answer time (unix ms), for the lost-connection sweeper
//
// Every transition is one compare-and-set script over the record and its indexes, so a
// second accept / hangup racing the first finds the new state and gets 409.

// TTL bounds how long a call record lives.
const TTL = 24 * time.Hour

func ringingKey() string              { return redisx.Key("call:ringing") }
func activeKey() string               { return redisx.Key("call:active") }
func recKey(id uuid.UUID) string      { return redisx.Key("call:" + id.String()) }
func userKey(u uuid.UUID) string      { return redisx.Key("user_call:" + u.String()) }
func onCallKey(u uuid.UUID) string    { return redisx.Key("call:oncall:" + u.String()) }
func ttlSec() string                  { return strconv.FormatInt(int64(TTL/time.Second), 10) }
func msStr(t time.Time) string        { return strconv.FormatInt(t.UnixMilli(), 10) }
func idOf(s string) (uuid.UUID, bool) { id, err := uuid.Parse(s); return id, err == nil }

// OnCallKey is the Valkey key that is set while the user is in an ACTIVE call; the gateway
// reads it for Presence.on_call.
func OnCallKey(u uuid.UUID) string { return onCallKey(u) }

// PhoneBusyKey is the telephony's busy key of a user (sip: an inbound call that rings them or
// that they took, ADR-0117; their personal call, ADR-0137 §3): a one-to-one call to them is BUSY.
func PhoneBusyKey(u uuid.UUID) string { return redisx.Key("sipin:user:" + u.String()) }

// ErrNotFound means there is no such call (it never existed or expired).
var ErrNotFound = errors.New("calls: not found")

// Start outcomes.
const (
	started = "OK"
	inCall  = "IN_CALL"
	busy    = "BUSY"
)

// startScript places a call unless the caller (IN_CALL) or the callee (BUSY) has one; a callee
// on a phone call (PhoneBusyKey: an inbound call rings or was taken, a personal call) is BUSY too.
// KEYS: call, user_call:caller, user_call:callee, ringing, phone busy:callee. ARGV: record, id,
// ttl s, deadline ms.
var startScript = rueidis.NewLuaScript(`
if redis.call('EXISTS', KEYS[2]) == 1 then return 'IN_CALL' end
if redis.call('EXISTS', KEYS[3]) == 1 or redis.call('EXISTS', KEYS[5]) == 1 then return 'BUSY' end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3])
redis.call('ZADD', KEYS[4], ARGV[4], ARGV[2])
return 'OK'`)

// casScript replaces the record if it still is ARGV[1] and keeps the indexes in step.
// KEYS: call, user_call:caller, user_call:callee, ringing, active, oncall:caller, oncall:callee.
// ARGV: old record, new record, id, mode (active | end | update), ttl s, answer ms.
var casScript = rueidis.NewLuaScript(`
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local mode = ARGV[4]
if mode == 'active' then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[5])
  redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[5])
  redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[5])
  redis.call('ZREM', KEYS[4], ARGV[3])
  redis.call('ZADD', KEYS[5], ARGV[6], ARGV[3])
  redis.call('SET', KEYS[6], ARGV[3], 'EX', ARGV[5])
  redis.call('SET', KEYS[7], ARGV[3], 'EX', ARGV[5])
  return 1
end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
if mode == 'end' then
  for _, i in ipairs({2, 3, 6, 7}) do
    if redis.call('GET', KEYS[i]) == ARGV[3] then redis.call('DEL', KEYS[i]) end
  end
  redis.call('ZREM', KEYS[4], ARGV[3])
  redis.call('ZREM', KEYS[5], ARGV[3])
end
return 1`)

// Store is the Valkey-backed call state.
type Store struct{ C rueidis.Client }

// Get reads a call.
func (s Store) Get(ctx context.Context, id uuid.UUID) (Record, error) {
	r, _, err := s.get(ctx, id)
	return r, err
}

func (s Store) get(ctx context.Context, id uuid.UUID) (Record, string, error) {
	raw, err := s.C.Do(ctx, s.C.B().Get().Key(recKey(id)).Build()).ToString()
	if rueidis.IsRedisNil(err) {
		return Record{}, "", ErrNotFound
	}
	if err != nil {
		return Record{}, "", err
	}
	var r Record
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		return Record{}, "", err
	}
	return r, raw, nil
}

// Current returns the user's RINGING / ACTIVE call (ok = false: none).
func (s Store) Current(ctx context.Context, u uuid.UUID) (Record, bool, error) {
	v, err := s.C.Do(ctx, s.C.B().Get().Key(userKey(u)).Build()).ToString()
	if rueidis.IsRedisNil(err) {
		return Record{}, false, nil
	}
	if err != nil {
		return Record{}, false, err
	}
	id, ok := idOf(v)
	if !ok {
		return Record{}, false, nil
	}
	r, err := s.Get(ctx, id)
	if errors.Is(err, ErrNotFound) || (err == nil && Terminal(r.State)) {
		return Record{}, false, nil
	}
	return r, err == nil, err
}

// Start stores a new RINGING call; it returns started, inCall or busy.
func (s Store) Start(ctx context.Context, r Record, deadline time.Time) (string, error) {
	b, err := json.Marshal(r)
	if err != nil {
		return "", err
	}
	return startScript.Exec(ctx, s.C, []string{recKey(r.ID), userKey(r.Caller), userKey(r.Callee), ringingKey(), PhoneBusyKey(r.Callee)},
		[]string{string(b), r.ID.String(), ttlSec(), msStr(deadline)}).ToString()
}

// Update applies fn to the call and stores the result atomically (compare-and-set, retried
// when the record changed meanwhile: fn then sees the new state). fn returning the record
// unchanged (same state and away map) writes nothing; an error from fn is returned as is.
func (s Store) Update(ctx context.Context, id uuid.UUID, fn func(Record) (Record, error)) (before, after Record, err error) {
	for range 8 {
		cur, raw, err := s.get(ctx, id)
		if err != nil {
			return cur, cur, err
		}
		next, err := fn(cur)
		if err != nil {
			return cur, cur, err
		}
		b, err := json.Marshal(next)
		if err != nil {
			return cur, cur, err
		}
		if string(b) == raw {
			return cur, next, nil
		}
		mode := "update"
		switch {
		case Terminal(next.State):
			mode = "end"
		case next.State == v1.CallState_CALL_STATE_ACTIVE && cur.State != v1.CallState_CALL_STATE_ACTIVE:
			mode = "active"
		}
		n, err := casScript.Exec(ctx, s.C,
			[]string{recKey(id), userKey(cur.Caller), userKey(cur.Callee), ringingKey(), activeKey(), onCallKey(cur.Caller), onCallKey(cur.Callee)},
			[]string{raw, string(b), id.String(), mode, ttlSec(), strconv.FormatInt(next.Answered, 10)}).AsInt64()
		if err != nil {
			return cur, cur, err
		}
		if n == 1 {
			return cur, next, nil
		}
	}
	return Record{}, Record{}, errors.New("calls: too much contention on a call")
}

// DueRinging returns ringing calls whose deadline passed.
func (s Store) DueRinging(ctx context.Context, now time.Time) ([]uuid.UUID, error) {
	return s.ids(ctx, s.C.B().Zrangebyscore().Key(ringingKey()).Min("-inf").Max(msStr(now)).Limit(0, 500).Build())
}

// ActiveIDs returns the ACTIVE calls (at most 1000 per sweep).
func (s Store) ActiveIDs(ctx context.Context) ([]uuid.UUID, error) {
	return s.ids(ctx, s.C.B().Zrange().Key(activeKey()).Min("0").Max("999").Build())
}

func (s Store) ids(ctx context.Context, cmd rueidis.Completed) ([]uuid.UUID, error) {
	ms, err := s.C.Do(ctx, cmd).AsStrSlice()
	if err != nil {
		return nil, err
	}
	out := make([]uuid.UUID, 0, len(ms))
	for _, m := range ms {
		if id, ok := idOf(m); ok {
			out = append(out, id)
		}
	}
	return out, nil
}

// Forget drops an id from the sweeper indexes (its record expired).
func (s Store) Forget(ctx context.Context, id uuid.UUID) error {
	return errors.Join(
		s.C.Do(ctx, s.C.B().Zrem().Key(ringingKey()).Member(id.String()).Build()).Error(),
		s.C.Do(ctx, s.C.B().Zrem().Key(activeKey()).Member(id.String()).Build()).Error())
}
