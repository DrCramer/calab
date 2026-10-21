package canvas

import "testing"

func TestCanvasBackendLogKey(t *testing.T) {
	if k := (canvasBackend{}).LogKey(); k != "doc_id" {
		t.Fatalf("log key %q", k)
	}
}
