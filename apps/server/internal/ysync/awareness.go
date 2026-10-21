package ysync

import (
	"bytes"
	"encoding/binary"
	"errors"
)

// awarenessEntry is one client's presence/cursor state in an awareness update.
type awarenessEntry struct {
	clientID uint64
	clock    uint64
	state    []byte // raw JSON state bytes (e.g. `{"cursor":...}` or `null`)
}

// maxFarewell is the largest frame of a single entry with the state null: the frame byte, the
// count, clientID and clock as varints, the state's length and "null".
const maxFarewell = 1 + 1 + 2*binary.MaxVarintLen64 + 1 + len("null")

// parseAwarenessUpdate decodes a y-protocols awareness update payload (excluding FrameAwareness byte).
// Format: varuint(len) [varuint(clientID), varuint(clock), varstring(state)]...
func parseAwarenessUpdate(b []byte) ([]awarenessEntry, error) {
	if len(b) == 0 {
		return nil, nil
	}
	count, n := binary.Uvarint(b)
	if n <= 0 {
		return nil, errors.New("ysync: invalid awareness count")
	}
	b = b[n:]
	// An entry takes at least 3 bytes (clientID, clock, an empty state's length): a larger count
	// is a malformed frame, never an allocation of the client's choosing.
	if count > uint64(len(b))/3 {
		return nil, errors.New("ysync: invalid awareness count")
	}
	entries := make([]awarenessEntry, 0, count)
	for i := uint64(0); i < count; i++ {
		clientID, n := binary.Uvarint(b)
		if n <= 0 {
			return nil, errors.New("ysync: invalid awareness clientID")
		}
		b = b[n:]
		clock, n := binary.Uvarint(b)
		if n <= 0 {
			return nil, errors.New("ysync: invalid awareness clock")
		}
		b = b[n:]
		strLen, n := binary.Uvarint(b)
		if n <= 0 || uint64(len(b[n:])) < strLen {
			return nil, errors.New("ysync: invalid awareness state length")
		}
		b = b[n:]
		state := bytes.Clone(b[:strLen])
		b = b[strLen:]
		entries = append(entries, awarenessEntry{
			clientID: clientID,
			clock:    clock,
			state:    state,
		})
	}
	return entries, nil
}

// encodeAwarenessUpdate encodes a list of awareness entries into a full frame with FrameAwareness prefix.
// The output is a valid y-protocols awareness update that standard Yjs clients apply directly.
func encodeAwarenessUpdate(entries []awarenessEntry) []byte {
	// FrameAwareness (1 byte) + varuint(count) + entries
	buf := make([]byte, 0, 1+binary.MaxVarintLen64+len(entries)*64)
	buf = append(buf, FrameAwareness)
	var tmp [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(tmp[:], uint64(len(entries)))
	buf = append(buf, tmp[:n]...)
	for _, e := range entries {
		n = binary.PutUvarint(tmp[:], e.clientID)
		buf = append(buf, tmp[:n]...)
		n = binary.PutUvarint(tmp[:], e.clock)
		buf = append(buf, tmp[:n]...)
		n = binary.PutUvarint(tmp[:], uint64(len(e.state)))
		buf = append(buf, tmp[:n]...)
		buf = append(buf, e.state...)
	}
	return buf
}

// isFarewell returns true if any entry has state "null" (meaning a client disconnected/removed state).
func isFarewell(entries []awarenessEntry) bool {
	for _, e := range entries {
		if bytes.Equal(e.state, []byte("null")) {
			return true
		}
	}
	return false
}
