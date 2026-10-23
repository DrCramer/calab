package ysync

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// An awareness update decodes back into the entries it was encoded from; every prefix of it, and
// a count no frame of its size can hold, is refused (a 15-byte frame once asked for 2^62 entries
// and panicked the server in a timer goroutine).
func TestParseAwarenessUpdate(t *testing.T) {
	in := []awarenessEntry{{clientID: 7, clock: 3, state: []byte(`{"c":1}`)}, {clientID: 1 << 40, clock: 1, state: []byte("null")}}
	full := encodeAwarenessUpdate(in)[1:]
	got, err := parseAwarenessUpdate(full)
	if err != nil || len(got) != len(in) {
		t.Fatalf("parse = %+v, %v", got, err)
	}
	for i := range in {
		if got[i].clientID != in[i].clientID || got[i].clock != in[i].clock || !bytes.Equal(got[i].state, in[i].state) {
			t.Fatalf("entry %d = %+v, want %+v", i, got[i], in[i])
		}
	}
	for i := 1; i < len(full); i++ {
		if _, err := parseAwarenessUpdate(full[:i]); err == nil {
			t.Fatalf("a prefix of %d bytes parsed", i)
		}
	}
	huge := append(binary.AppendUvarint(nil, 1<<62), 7, 2, 2, '{', '}')
	if _, err := parseAwarenessUpdate(huge); err == nil {
		t.Fatal("a count of 2^62 entries parsed")
	}
	if f := encodeAwarenessUpdate([]awarenessEntry{{clientID: ^uint64(0), clock: ^uint64(0), state: []byte("null")}}); len(f) != maxFarewell {
		t.Fatalf("the largest farewell is %d bytes, maxFarewell %d", len(f), maxFarewell)
	}
}

// Whatever a client sends, the parse returns an error or entries that take no more bytes encoded
// than were sent (nothing is allocated beyond what the frame holds).
func FuzzParseAwarenessUpdate(f *testing.F) {
	f.Add(encodeAwarenessUpdate([]awarenessEntry{{clientID: 7, clock: 3, state: []byte(`{"c":1}`)}})[1:])
	f.Add(append(binary.AppendUvarint(nil, 1<<62), 7, 2, 2, '{', '}'))
	f.Add([]byte{0xEE})
	f.Fuzz(func(t *testing.T, b []byte) {
		entries, err := parseAwarenessUpdate(b)
		if err != nil || len(b) == 0 {
			return
		}
		if back := encodeAwarenessUpdate(entries)[1:]; len(back) > len(b) {
			t.Fatalf("%d entries from %d bytes encode to %d", len(entries), len(b), len(back))
		}
	})
}
