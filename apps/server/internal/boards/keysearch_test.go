package boards

import (
	"slices"
	"testing"
)

func TestParseLooseKey(t *testing.T) {
	has := func(q KeyQuery, p string) bool { return slices.Contains(q.Prefixes, p) }
	for _, in := range []string{"DOC-532", "doc532", "doc 532", "doc_532", "DOC532", "Doc - 532", " doc-532 ", "док-532", "ДОК532", "вщс-532"} {
		q, ok := ParseLooseKey(in)
		if !ok || q.Number != 532 || !has(q, "DOC") {
			t.Errorf("%q -> %+v %v, want DOC-532", in, q, ok)
		}
	}
	if q, ok := ParseLooseKey("штм-820"); !ok || q.Number != 820 || !has(q, "INV") {
		t.Errorf("штм-820 -> %+v %v", q, ok)
	}
	if q, ok := ParseLooseKey("a1-5"); !ok || !has(q, "A1") || q.Number != 5 {
		t.Errorf("a1-5 -> %+v %v", q, ok)
	}
	for _, in := range []string{"532", "#532"} {
		if q, ok := ParseLooseKey(in); !ok || q.Number != 532 || len(q.Prefixes) != 0 {
			t.Errorf("%q -> %+v %v, want a bare number", in, q, ok)
		}
	}
	for _, in := range []string{"", "doc", "d-5", "toolongprefix-5", "doc-0", "532 doc", "hello world 5", "1234567890123", "-5", "док"} {
		if q, ok := ParseLooseKey(in); ok {
			t.Errorf("%q -> %+v, want no key", in, q)
		}
	}
}
