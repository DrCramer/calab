package sip

import (
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/rtc"
)

// TestResolveCallers: a contact wins over an employee's phone, an employee's phone over the
// bare number, and a phone two employees share names nobody.
func TestResolveCallers(t *testing.T) {
	contact, anna, boris, vera := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	contacts := map[string]Caller{"+79160000001": {ContactID: &contact, Name: "Анна Петрова", Company: "ООО Ромашка"}}
	members := map[string][]uuid.UUID{
		"+79160000001": {anna},        // the contact has it too: the contact wins
		"+79160000002": {boris},       // an employee's phone
		"+79160000003": {vera, boris}, // shared: nobody
	}
	got := resolveCallers([]string{"+79160000001", "+79160000002", "+79160000003", "+79160000004", ""}, contacts, members)
	if c := got["+79160000001"]; c.ContactID == nil || *c.ContactID != contact || c.UserID != nil || c.Company != "ООО Ромашка" {
		t.Fatalf("contact: %+v", c)
	}
	if c := got["+79160000002"]; c.ContactID != nil || c.UserID == nil || *c.UserID != boris {
		t.Fatalf("employee: %+v", c)
	}
	for _, n := range []string{"+79160000003", "+79160000004", ""} {
		if c, ok := got[n]; ok || c.Known() {
			t.Fatalf("%q: %+v", n, c)
		}
	}
}

func TestFillCallerAndBots(t *testing.T) {
	contact, user := uuid.New(), uuid.New()
	pb := FillCaller(&v1.SipCall{Number: "+79160000001"}, Caller{ContactID: &contact, Name: "Анна", Company: "ООО"})
	if pb.GetContactId() != contact.String() || pb.GetCallerName() != "Анна" || pb.GetCallerCompany() != "ООО" || pb.GetCallerUserId() != "" {
		t.Fatalf("contact: %v", pb)
	}
	pb = FillCaller(&v1.SipCall{}, Caller{UserID: &user})
	if b := forBot(pb); b.GetCallerUserId() != "" || pb.GetCallerUserId() != user.String() {
		t.Fatalf("a bot's copy: %v / %v", b, pb)
	}
	if !callerShown(&v1.SipCall{Direction: v1.SipCallDirection_SIP_CALL_DIRECTION_IN}) ||
		!callerShown(&v1.SipCall{Origin: v1.SipCallOrigin_SIP_CALL_ORIGIN_PERSONAL}) ||
		callerShown(&v1.SipCall{Origin: v1.SipCallOrigin_SIP_CALL_ORIGIN_ROOM}) {
		t.Fatal("callerShown")
	}
}

func TestOutboundRoomName(t *testing.T) {
	ws, call, user := uuid.New(), uuid.New(), uuid.New()
	name := rtc.OutboundRoomName(ws, call)
	if w, c, ok := rtc.ParseOutboundRoom(name); !ok || w != ws || c != call || !rtc.IsOutboundRoom(name) || rtc.IsInboundRoom(name) {
		t.Fatalf("%s: %v %v %v", name, w, c, ok)
	}
	for _, bad := range []string{"sipout_x", "sipin_" + ws.String() + "_" + call.String(), "sipout_" + ws.String() + "-" + call.String()} {
		if _, _, ok := rtc.ParseOutboundRoom(bad); ok {
			t.Fatalf("parsed %q", bad)
		}
	}
	if u, ok := rtc.ParseCallerIdentity(rtc.CallerIdentity(user)); !ok || u != user {
		t.Fatal("caller identity")
	}
	if _, ok := rtc.ParseCallerIdentity(rtc.AnswerIdentity(user)); ok {
		t.Fatal("an answer identity is no caller")
	}
}

func TestSplitQuery(t *testing.T) {
	for in, want := range map[string][2]string{
		"+7 (916) 123": {"", "7916123"}, "Ромашка": {"Ромашка", ""}, "ООО 1": {"ООО 1", ""}, "  ": {"", ""},
	} {
		if text, digits := splitQuery(in); text != want[0] || digits != want[1] {
			t.Fatalf("%q: %q %q", in, text, digits)
		}
	}
	if c, ok := decodeContactCursor("not base64!"); ok {
		t.Fatalf("cursor: %+v", c)
	}
}
