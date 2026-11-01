//go:build integration

package app_test

import (
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/messages"
)

func receiptOf(roomID string) func(*v1.DispatchEvent) bool {
	return func(e *v1.DispatchEvent) bool { return e.GetReadReceipt().GetRoomId() == roomID }
}

// readUpTo: the message was on screen (seen, ADR-0140) — the way the feed marks it.
func readUpTo(t *testing.T, c *client, roomID, messageID string) {
	t.Helper()
	c.must(204, "PUT", "/api/rooms/"+roomID+"/read", &v1.UpdateReadStateRequest{MessageId: messageID, Seen: true}, nil)
}

// markOnly: «mark as read» without looking — moves the read marker only (ADR-0140 §1).
func markOnly(t *testing.T, c *client, roomID, messageID string) {
	t.Helper()
	c.must(204, "PUT", "/api/rooms/"+roomID+"/read", &v1.UpdateReadStateRequest{MessageId: messageID}, nil)
}

func wantReceipt(t *testing.T, g *gw, who, roomID, messageID string) {
	t.Helper()
	e := g.wait("READ_RECEIPT "+who, receiptOf(roomID))
	if pr := e.GetReadReceipt(); pr.GetLastReadMessageId() != messageID || pr.GetExceptUserId() != "" {
		t.Fatalf("READ_RECEIPT %s: %v, want %s", who, pr, messageID)
	}
}

// TestReadReceiptsDM: the peer's read goes to the author at once (docs/09 #92), not to the
// reader's own devices, only when the seen marker moves; READY and GET /api/dms carry it.
func TestReadReceiptsDM(t *testing.T) {
	o, bob, _, _ := setupTeam(t)
	rid := openDM(t, o, bob.id, 201).GetRoom().GetId()
	og, bg := dialGW(t), dialGW(t)
	og.identify(o.token)
	bg.identify(bob.token)
	m1 := send(t, o, rid, "one", uniq("rr-dm-1-"))
	m2 := send(t, o, rid, "two", uniq("rr-dm-2-"))

	readUpTo(t, bob.client, rid, m1.GetId())
	wantReceipt(t, og, "o", rid, m1.GetId())
	bg.quiet("own READ_RECEIPT", 300*time.Millisecond, receiptOf(rid))
	// Not moved (same / older marker): no event.
	readUpTo(t, bob.client, rid, m1.GetId())
	og.quiet("READ_RECEIPT without a move", 300*time.Millisecond, receiptOf(rid))
	// «Mark as read» is not «seen» (ADR-0140): the read marker moves, the ticks do not.
	markOnly(t, bob.client, rid, m2.GetId())
	og.quiet("READ_RECEIPT for a mark without seeing", 300*time.Millisecond, receiptOf(rid))

	og = dialGW(t) // the same device: replaces the previous socket
	ready := og.identify(o.token)
	if ready.GetReadReceiptsFrom() == "" || ready.GetReadReceiptsFrom() > m1.GetId() {
		t.Fatalf("READY.read_receipts_from = %q, want ≤ %s", ready.GetReadReceiptsFrom(), m1.GetId())
	}
	for _, d := range ready.GetDms() {
		if d.GetRoom().GetId() == rid && d.GetPeerReadMessageId() != m1.GetId() {
			t.Fatalf("READY dm peer_read_message_id = %q, want %s", d.GetPeerReadMessageId(), m1.GetId())
		}
	}
	readUpTo(t, bob.client, rid, m2.GetId())
	wantReceipt(t, og, "o (2)", rid, m2.GetId())
	// o is the instance owner shared by every test (owner()): pick this DM out of their list.
	if got := dmPeerRead(t, o, rid); got != m2.GetId() {
		t.Fatalf("GET /api/dms peer read: %q, want %s", got, m2.GetId())
	}
	// Sending is not seeing: bob sees no ticks of his until o's feed shows them.
	if got := dmPeerRead(t, bob, rid); got != "" {
		t.Fatalf("bob's peer read before o saw anything: %q", got)
	}
	readUpTo(t, o.client, rid, m2.GetId())
	if got := dmPeerRead(t, bob, rid); got != m2.GetId() {
		t.Fatalf("bob's peer read: %q, want %s", got, m2.GetId())
	}
}

// dmPeerRead returns peer_read_message_id of the DM rid in u's GET /api/dms.
func dmPeerRead(t *testing.T, u *user, rid string) string {
	t.Helper()
	var dl v1.ListDmsResponse
	u.must(200, "GET", "/api/dms", nil, &dl)
	for _, d := range dl.GetDms() {
		if d.GetRoom().GetId() == rid {
			return d.GetPeerReadMessageId()
		}
	}
	t.Fatalf("GET /api/dms: no DM %s", rid)
	return ""
}

// TestReadReceiptsRoom: in a workspace room the furthest seen marker of the others goes to the
// members at most once per window (a leading and a trailing event), only when it advances for
// someone; bots' reads and «mark as read» do not count and bots get no receipts.
func TestReadReceiptsRoom(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	b := createBot(t, o, wid, "Reader")
	rid := textRoom(t, o, wid, "receipts", false)
	og, bg, cg, botg := dialGW(t), dialGW(t), dialGW(t), dialGW(t)
	og.identify(o.token)
	bg.identify(bob.token)
	cg.identify(carol.token)
	botg.identify(b.token)
	m1 := send(t, o, rid, "one", uniq("rr-1-"))
	m2 := send(t, o, rid, "two", uniq("rr-2-"))
	m3 := send(t, o, rid, "three", uniq("rr-3-"))

	// Leading edge, at once: bob is the only one who saw anything — everyone else gets his m1,
	// he gets nothing (nobody else saw).
	start := time.Now()
	readUpTo(t, bob.client, rid, m1.GetId())
	wantReceipt(t, og, "o", rid, m1.GetId())
	wantReceipt(t, cg, "carol", rid, m1.GetId())
	bg.quiet("READ_RECEIPT of bob's own marker", 300*time.Millisecond, receiptOf(rid))

	// Inside the window: no event now, one trailing event at its end with the state then:
	// carol is the furthest (m3) — she gets the next furthest, bob's m2.
	readUpTo(t, bob.client, rid, m2.GetId())
	readUpTo(t, carol.client, rid, m3.GetId())
	og.quiet("READ_RECEIPT inside the window", messages.ReceiptWindow-time.Since(start)-300*time.Millisecond, receiptOf(rid))
	wantReceipt(t, og, "o (trailing)", rid, m3.GetId())
	wantReceipt(t, cg, "carol (trailing)", rid, m2.GetId())
	og.quiet("a second trailing READ_RECEIPT", 500*time.Millisecond, receiptOf(rid))

	// Does not move: carol is past m2.
	time.Sleep(messages.ReceiptWindow)
	readUpTo(t, carol.client, rid, m2.GetId())
	og.quiet("READ_RECEIPT without a move", 300*time.Millisecond, receiptOf(rid))

	// «Mark as read» and a bot's read: no event, and they do not count in READY.
	m4 := send(t, o, rid, "four", uniq("rr-4-"))
	markOnly(t, bob.client, rid, m4.GetId())
	readUpTo(t, b.client, rid, m4.GetId())
	og.quiet("READ_RECEIPT for a mark or a bot's read", 500*time.Millisecond, receiptOf(rid))
	ready := dialGW(t).identify(o.token)
	found := false
	for _, pr := range ready.GetPeerReads() {
		if pr.GetRoomId() == rid {
			found = true
			if pr.GetLastReadMessageId() != m3.GetId() || pr.GetExceptUserId() != "" {
				t.Fatalf("READY peer read: %v, want %s", pr, m3.GetId())
			}
		}
	}
	if !found {
		t.Fatal("READY.peer_reads misses the room")
	}
	botg.quiet("READ_RECEIPT to a bot", 200*time.Millisecond, receiptOf(rid))
}

func readerIDs(rs []*v1.MessageReader) []string {
	out := make([]string, 0, len(rs))
	for _, r := range rs {
		out = append(out, r.GetUserId())
	}
	return out
}

func wantReaders(t *testing.T, what string, rs []*v1.MessageReader, ids ...string) {
	t.Helper()
	got := readerIDs(rs)
	if len(got) != len(ids) {
		t.Fatalf("%s readers = %v, want %v", what, got, ids)
	}
	for i := range ids {
		if got[i] != ids[i] {
			t.Fatalf("%s readers = %v, want %v", what, got, ids)
		}
		if at := rs[i].GetReadAt().AsTime(); time.Since(at) > time.Minute || time.Until(at) > time.Second {
			t.Fatalf("%s read_at %v is not now", what, at)
		}
	}
}

func readersOf(t *testing.T, c *client, roomID, messageID string) []*v1.MessageReader {
	t.Helper()
	var r v1.ListMessageReadersResponse
	c.must(200, "GET", "/api/rooms/"+roomID+"/messages/"+messageID+"/readers", nil, &r)
	return r.GetReaders()
}

// TestReadReceiptsReaders (ADR-0140): «Прочитали» — who saw a message and when — only to its
// author (the readers route, GET message, a bot's message list), from the runs of the seen
// marker; «mark as read», bots and the author never count; task rooms work the same.
func TestReadReceiptsReaders(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	b := createBot(t, o, wid, "Readers")
	rid := textRoom(t, o, wid, "readers", false)
	m1 := send(t, o, rid, "one", uniq("rd-1-"))
	m2 := send(t, o, rid, "two", uniq("rd-2-"))

	readUpTo(t, bob.client, rid, m2.GetId())   // bob saw both
	markOnly(t, carol.client, rid, m2.GetId()) // carol only marked
	readUpTo(t, b.client, rid, m2.GetId())     // a bot never counts
	wantReaders(t, "m1", readersOf(t, o.client, rid, m1.GetId()), bob.id)
	wantReaders(t, "m2", readersOf(t, o.client, rid, m2.GetId()), bob.id)

	// Only the author: everyone else gets 403 and no read_by.
	bob.must(403, "GET", "/api/rooms/"+rid+"/messages/"+m1.GetId()+"/readers", nil, nil)
	carol.must(403, "GET", "/api/rooms/"+rid+"/messages/"+m1.GetId()+"/readers", nil, nil)
	var got v1.Message
	bob.must(200, "GET", "/api/rooms/"+rid+"/messages/"+m1.GetId(), nil, &got)
	if len(got.GetReadBy()) != 0 {
		t.Fatalf("read_by to a non-author: %v", got.GetReadBy())
	}
	o.must(200, "GET", "/api/rooms/"+rid+"/messages/"+m1.GetId(), nil, &got)
	wantReaders(t, "GET m1", got.GetReadBy(), bob.id)
	// A person's list carries no read_by, only the room's ✓✓ marker.
	var page v1.ListMessagesResponse
	o.must(200, "GET", "/api/rooms/"+rid+"/messages", nil, &page)
	for _, m := range page.GetMessages() {
		if len(m.GetReadBy()) != 0 {
			t.Fatalf("read_by in a person's list: %v", m)
		}
	}
	if page.GetPeerReadMessageId() != m2.GetId() {
		t.Fatalf("list peer_read_message_id = %q, want %s", page.GetPeerReadMessageId(), m2.GetId())
	}

	// carol now sees m1, then m2: one run that grows; both messages list her after bob.
	readUpTo(t, carol.client, rid, m1.GetId())
	readUpTo(t, carol.client, rid, m2.GetId())
	wantReaders(t, "m1 (2)", readersOf(t, o.client, rid, m1.GetId()), bob.id, carol.id)
	wantReaders(t, "m2 (2)", readersOf(t, o.client, rid, m2.GetId()), bob.id, carol.id)

	// A bot learns who saw its own message from its message list; others' messages stay bare.
	var bm v1.CreateMessageResponse
	b.must(201, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: "видел?", Nonce: uniq("rd-b-")}, &bm)
	readUpTo(t, bob.client, rid, bm.GetMessage().GetId())
	b.must(200, "GET", "/api/rooms/"+rid+"/messages", nil, &page)
	for _, m := range page.GetMessages() {
		switch m.GetId() {
		case bm.GetMessage().GetId():
			wantReaders(t, "bot's message", m.GetReadBy(), bob.id)
		default:
			if len(m.GetReadBy()) != 0 {
				t.Fatalf("read_by of someone else's message to a bot: %v", m)
			}
		}
	}

	// Task comments: the same receipts in the task room.
	board := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Отметки"}, 201)
	task := createTask(t, o, board.GetId(), &v1.CreateTaskRequest{Title: "Прочитали"}, 201)
	c1 := send(t, o, task.GetRoomId(), "комментарий", uniq("rd-c-"))
	readUpTo(t, bob.client, task.GetRoomId(), c1.GetId())
	wantReaders(t, "comment", readersOf(t, o.client, task.GetRoomId(), c1.GetId()), bob.id)
	o.must(200, "GET", "/api/rooms/"+task.GetRoomId()+"/messages", nil, &page)
	if page.GetPeerReadMessageId() != c1.GetId() {
		t.Fatalf("task room peer_read_message_id = %q, want %s", page.GetPeerReadMessageId(), c1.GetId())
	}
}

// TestReadReceiptsOnBehalf (ADR-0140 review): a bot acting for a person reads without a screen
// behind it — its seen never counts, for the owner (ADR-0106) or a consenting member (ADR-0111);
// a bot acting for a consenting member never learns who read the member's messages (its token is
// the bot owner's), while one acting for its own owner does.
func TestReadReceiptsOnBehalf(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	rid := textRoom(t, o, wid, "on-behalf-readers", false)
	b := createBot(t, o, wid, "Delegate")
	if st, _ := setActsAsOwner(o, wid, b.id, true); st != 200 {
		t.Fatalf("acts_as_owner: %d", st)
	}
	bob.must(200, "PUT", "/api/workspaces/"+wid+"/bots/"+b.id+"/delegations/"+bob.id, nil, nil)
	m1 := send(t, bob, rid, "от боба", uniq("rd-ob-1-"))
	m2 := send(t, o, rid, "от владельца", uniq("rd-ob-2-"))

	// seen on behalf moves nothing: no readers, no ✓✓ for anyone.
	asOwner(b).must(204, "PUT", "/api/rooms/"+rid+"/read", &v1.UpdateReadStateRequest{MessageId: m2.GetId(), Seen: true}, nil)
	asMember(b, bob.id).must(204, "PUT", "/api/rooms/"+rid+"/read", &v1.UpdateReadStateRequest{MessageId: m2.GetId(), Seen: true}, nil)
	wantReaders(t, "m2 after on-behalf seen", readersOf(t, o.client, rid, m2.GetId()))
	var page v1.ListMessagesResponse
	o.must(200, "GET", "/api/rooms/"+rid+"/messages", nil, &page)
	if page.GetPeerReadMessageId() != "" {
		t.Fatalf("peer_read_message_id after on-behalf seen = %q", page.GetPeerReadMessageId())
	}

	// The owner really reads bob's message: bob's delegate learns nothing of it.
	readUpTo(t, o.client, rid, m1.GetId())
	wantReaders(t, "m1 to bob", readersOf(t, bob.client, rid, m1.GetId()), o.id)
	mb := asMember(b, bob.id)
	wantReason(t, mb, mb.do("GET", "/api/rooms/"+rid+"/messages/"+m1.GetId()+"/readers", nil, nil), 403, "ON_BEHALF_ROUTE")
	var got v1.Message
	mb.must(200, "GET", "/api/rooms/"+rid+"/messages/"+m1.GetId(), nil, &got)
	if len(got.GetReadBy()) != 0 {
		t.Fatalf("read_by to a member's delegate: %v", got.GetReadBy())
	}

	// bob reads the owner's message: the owner's own bot may tell the owner.
	readUpTo(t, bob.client, rid, m2.GetId())
	wantReaders(t, "m2 to the owner's bot", readersOf(t, asOwner(b), rid, m2.GetId()), bob.id)
}
