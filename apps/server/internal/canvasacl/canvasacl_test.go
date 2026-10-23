package canvasacl

import (
	"testing"

	"github.com/calaba/calaba/server/internal/perm"
)

// The chain an event carries survives the round trip through its proto form, and SameChain tells
// a changed chain from an unchanged one.
func TestLevelsRoundTrip(t *testing.T) {
	chain := []perm.TreeNode{
		{OwnerID: "u1"},
		{Restricted: true, OwnerID: "u2", Overrides: []perm.OverrideTarget{
			{TargetType: "user", TargetID: "u3", Override: perm.Override{Allow: perm.CanvasView | perm.CanvasWrite}},
			{TargetType: "role", TargetID: "r1", Override: perm.Override{Deny: perm.CanvasWrite}},
		}},
	}
	back := FromLevels(Levels(chain))
	if !SameChain(chain, back) {
		t.Fatalf("round trip: %+v → %+v", chain, back)
	}
	changed := FromLevels(Levels(chain))
	changed[1].Restricted = false
	if SameChain(chain, changed) || SameChain(chain, chain[:1]) {
		t.Fatal("SameChain missed a change")
	}
}
