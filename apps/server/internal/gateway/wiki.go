package gateway

import v1 "github.com/calaba/calaba/server/gen/calaba/v1"

// Wiki events (ADR-0096 §8). Like the Disk's, each WIKI_PAGE_* event carries the page's access
// chain (server-internal) and must reach only the page's viewers (WIKI_VIEW,
// perm.ComputeWikiPageIn). Until that per-recipient routing lands (wiki v1 task W2) they are
// dropped here: fail closed, never broadcast to the whole workspace with the chain attached.

// routeWiki swallows WIKI_PAGE_UPSERT / WIKI_PAGE_REMOVE; false = not a wiki event.
func routeWiki(ev *v1.DispatchEvent) bool {
	switch ev.GetEvent().(type) {
	case *v1.DispatchEvent_WikiPageUpsert, *v1.DispatchEvent_WikiPageRemove:
		return true
	}
	return false
}
