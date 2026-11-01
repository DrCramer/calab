package office

import (
	"context"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/redisx"
)

// ValkeySessions keeps the live co-editing sessions in Valkey (ADR-0143 §5): one hash per item
// office:s:{item} with
//
//	k       the session's document.key
//	f       the file the session's edits stand on (forcesave moves it)
//	e:{uid} a member who got an edit configuration of this session: "1", or "0" once dropped
//	        for losing «Правка» (revoked: not «editing», still rechecked)
//	v:{uid} a member who got a view configuration of this session
//	on      the connected editors, comma-separated (the last status 1)
//
// and a TTL that every open and every callback renews; the set office:live lists the items with
// a session (the access sweep). Every change is one script: atomic per item.
type ValkeySessions struct {
	C   rueidis.Client
	TTL time.Duration
}

func sessKey(item uuid.UUID) string { return redisx.Key("office:s:" + item.String()) }
func liveKey() string               { return redisx.Key("office:live") }

// joinScript: KEYS session, live. ARGV key, file, user, mode (e | v), ttl s, item.
var joinScript = rueidis.NewLuaScript(`
if redis.call('HEXISTS', KEYS[1], 'k') == 0 then
  redis.call('DEL', KEYS[1])
  redis.call('HSET', KEYS[1], 'k', ARGV[1], 'f', ARGV[2])
end
if ARGV[4] == 'e' then redis.call('HSET', KEYS[1], 'e:' .. ARGV[3], '1')
else redis.call('HSET', KEYS[1], 'v:' .. ARGV[3], '1') end
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('SADD', KEYS[2], ARGV[6])
return redis.call('HMGET', KEYS[1], 'k', 'f')`)

// casScript runs one change on the session with key ARGV[1] (0 when it is another or gone).
// KEYS session, live. ARGV key, op (advance | online | revoke | forget | end), value, ttl s, item.
var casScript = rueidis.NewLuaScript(`
if redis.call('HGET', KEYS[1], 'k') ~= ARGV[1] then return 0 end
local op = ARGV[2]
if op == 'end' then
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[5])
  return 1
end
if op == 'advance' then redis.call('HSET', KEYS[1], 'f', ARGV[3]) end
if op == 'online' then
  local was = redis.call('HGET', KEYS[1], 'on') or ''
  redis.call('HSET', KEYS[1], 'on', ARGV[3])
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  if was == ARGV[3] then return 1 end
  return 2
end
if op == 'revoke' then
  for id in string.gmatch(ARGV[3], '[^,]+') do
    if redis.call('HEXISTS', KEYS[1], 'e:' .. id) == 1 then redis.call('HSET', KEYS[1], 'e:' .. id, '0') end
  end
end
if op == 'forget' then
  for id in string.gmatch(ARGV[3], '[^,]+') do redis.call('HDEL', KEYS[1], 'e:' .. id, 'v:' .. id) end
end
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1`)

func (v ValkeySessions) ttl() string {
	t := v.TTL
	if t <= 0 {
		t = 24 * time.Hour
	}
	return strconv.Itoa(int(t / time.Second))
}

// Join implements Sessions.
func (v ValkeySessions) Join(ctx context.Context, item uuid.UUID, s Session, user uuid.UUID, edit bool) (Session, error) {
	mode := "v"
	if edit {
		mode = "e"
	}
	vals, err := joinScript.Exec(ctx, v.C, []string{sessKey(item), liveKey()},
		[]string{s.Key, s.FileID.String(), user.String(), mode, v.ttl(), item.String()}).ToArray()
	if err != nil {
		return Session{}, err
	}
	k, _ := vals[0].ToString()
	f, _ := vals[1].ToString()
	fid, err := uuid.Parse(f)
	if err != nil {
		return Session{}, err
	}
	return Session{Key: k, FileID: fid}, nil
}

// Get implements Sessions.
func (v ValkeySessions) Get(ctx context.Context, item uuid.UUID) (Session, bool, error) {
	m, err := v.C.Do(ctx, v.C.B().Hgetall().Key(sessKey(item)).Build()).AsStrMap()
	if err != nil {
		return Session{}, false, err
	}
	return parseSession(m)
}

func parseSession(m map[string]string) (Session, bool, error) {
	if m["k"] == "" {
		return Session{}, false, nil
	}
	fid, err := uuid.Parse(m["f"])
	if err != nil {
		return Session{}, false, err
	}
	s := Session{Key: m["k"], FileID: fid}
	for k, val := range m {
		mark, id, ok := strings.Cut(k, ":")
		if !ok {
			continue
		}
		u, err := uuid.Parse(id)
		if err != nil {
			continue
		}
		switch {
		case mark == "e" && val == "0":
			s.Revoked = append(s.Revoked, u)
		case mark == "e":
			s.Editors = append(s.Editors, u)
		case mark == "v":
			s.Viewers = append(s.Viewers, u)
		}
	}
	for _, id := range strings.Split(m["on"], ",") {
		if u, err := uuid.Parse(id); err == nil {
			s.Online = append(s.Online, u)
		}
	}
	return s, true, nil
}

func (v ValkeySessions) cas(ctx context.Context, item uuid.UUID, key, op, value string) (int64, error) {
	return casScript.Exec(ctx, v.C, []string{sessKey(item), liveKey()}, []string{key, op, value, v.ttl(), item.String()}).AsInt64()
}

// Advance implements Sessions.
func (v ValkeySessions) Advance(ctx context.Context, item uuid.UUID, key string, fileID uuid.UUID) (bool, error) {
	n, err := v.cas(ctx, item, key, "advance", fileID.String())
	return n > 0, err
}

func joinIDs(ids []uuid.UUID) string {
	s := make([]string, len(ids))
	for i, id := range ids {
		s[i] = id.String()
	}
	slices.Sort(s)
	return strings.Join(slices.Compact(s), ",")
}

// Online implements Sessions.
func (v ValkeySessions) Online(ctx context.Context, item uuid.UUID, key string, users []uuid.UUID) (bool, error) {
	n, err := v.cas(ctx, item, key, "online", joinIDs(users))
	return n == 2, err
}

// Revoke implements Sessions.
func (v ValkeySessions) Revoke(ctx context.Context, item uuid.UUID, key string, users []uuid.UUID) error {
	_, err := v.cas(ctx, item, key, "revoke", joinIDs(users))
	return err
}

// Forget implements Sessions.
func (v ValkeySessions) Forget(ctx context.Context, item uuid.UUID, key string, users []uuid.UUID) error {
	_, err := v.cas(ctx, item, key, "forget", joinIDs(users))
	return err
}

// End implements Sessions.
func (v ValkeySessions) End(ctx context.Context, item uuid.UUID, key string) error {
	_, err := v.cas(ctx, item, key, "end", "")
	return err
}

// Live implements Sessions; items whose session expired leave the set here.
func (v ValkeySessions) Live(ctx context.Context) ([]uuid.UUID, error) {
	ids, err := v.C.Do(ctx, v.C.B().Smembers().Key(liveKey()).Build()).AsStrSlice()
	if err != nil {
		return nil, err
	}
	var out []uuid.UUID
	for _, raw := range ids {
		id, err := uuid.Parse(raw)
		if err != nil {
			continue
		}
		n, err := v.C.Do(ctx, v.C.B().Exists().Key(sessKey(id)).Build()).AsInt64()
		if err != nil {
			return nil, err
		}
		if n == 0 {
			_ = v.C.Do(ctx, v.C.B().Srem().Key(liveKey()).Member(raw).Build()).Error()
			continue
		}
		out = append(out, id)
	}
	return out, nil
}

// EditorsOf implements disk.Editors: per item, the connected members who got an edit
// configuration of its session (viewers are not «editing»). One round trip for the page.
func (v ValkeySessions) EditorsOf(ctx context.Context, items []uuid.UUID) (map[uuid.UUID][]uuid.UUID, error) {
	cmds := make(rueidis.Commands, len(items))
	for i, id := range items {
		cmds[i] = v.C.B().Hgetall().Key(sessKey(id)).Build()
	}
	out := map[uuid.UUID][]uuid.UUID{}
	for i, res := range v.C.DoMulti(ctx, cmds...) {
		m, err := res.AsStrMap()
		if err != nil {
			return nil, err
		}
		s, ok, err := parseSession(m)
		if err != nil || !ok || i >= len(items) {
			continue
		}
		id := items[i] //nolint:gosec // DoMulti answers one result per command, i < len(items) checked
		for _, u := range s.Online {
			if slices.Contains(s.Editors, u) {
				out[id] = append(out[id], u)
			}
		}
	}
	return out, nil
}
