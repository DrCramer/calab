package wiki

import "testing"

// The relay's Warn lines name the document with the key the Wiki's production log queries use.
func TestWikiBackendLogKey(t *testing.T) {
	if k := (wikiBackend{}).LogKey(); k != "page_id" {
		t.Fatalf("log key %q", k)
	}
}
