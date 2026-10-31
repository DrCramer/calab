//go:build integration

package app_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rtc"
)

// contactsUpload posts a CSV to …/sip/contacts/import (multipart, part «file»).
func contactsUpload(t *testing.T, token, path string, data []byte) (int, *v1.ImportSipContactsResponse, *v1.ApiError) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "contacts.csv")
	_, _ = fw.Write(data)
	_ = mw.Close()
	req, _ := http.NewRequestWithContext(context.Background(), "POST", srv.URL+path, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		var e v1.ApiError
		_ = protojson.Unmarshal(raw, &e)
		return resp.StatusCode, nil, &e
	}
	var out v1.ImportSipContactsResponse
	if err := protojson.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, &out, nil
}

func rawGet(t *testing.T, token, path string) (int, string) {
	t.Helper()
	req, _ := http.NewRequestWithContext(context.Background(), "GET", srv.URL+path, http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(raw)
}

func contactNames(r *v1.ListSipContactsResponse) []string {
	out := []string{}
	for _, c := range r.GetContacts() {
		if c.GetName() != "" {
			out = append(out, c.GetName())
		} else {
			out = append(out, c.GetCompany())
		}
	}
	return out
}

// TestSIPContacts (ADR-0137 §2): who sees the phone book (the section's rule on the server),
// CRUD with normalised numbers, a number of one contact only (409 with its owner), delete by the
// author or MANAGE_INTEGRATIONS, CSV import (preview, skips, limits) and export (formulas
// defused) by MANAGE_INTEGRATIONS only, bots by the same rules, the list's order, search and
// pages, caller ID of an inbound call and in the journal (a contact, an employee's phone), the
// journal's search by name, and retention.
func TestSIPContacts(t *testing.T) {
	ctx := context.Background()
	a, server, _, _ := inboundApp(t)
	o := owner(t)
	wid := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	bob := register(t, invite(t, o, wid))   // an internal number: sees the section
	carol := register(t, invite(t, o, wid)) // nothing: does not
	dave := register(t, invite(t, o, wid))  // VIEW_JOURNALS through a role
	base := "/api/workspaces/" + wid + "/sip"
	contacts := base + "/contacts"

	// Before telephony is connected only MANAGE_INTEGRATIONS sees the section.
	o.must(200, "GET", contacts, nil, nil)
	bob.must(403, "GET", contacts, nil, nil)
	o.must(200, "PUT", base, &v1.PutSipSettingsRequest{Enabled: true, Provider: "Zadarma", Host: "203.0.113.10", CallerId: "+74951230237"}, nil)
	var bobExt v1.SipExtensionResponse
	o.must(201, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "101", UserId: bob.id}, &bobExt)
	role := newRole(t, o, wid, "Журналы", perm.ViewJournals)
	if st, _ := setMemberRoles(o, wid, dave.id, role.GetId()); st != 200 {
		t.Fatalf("dave's role: %d", st)
	}
	bob.must(200, "GET", contacts, nil, nil)
	dave.must(200, "GET", contacts, nil, nil)
	carol.must(403, "GET", contacts, nil, nil)
	carol.must(403, "POST", contacts, &v1.SipContactInput{Name: "X", Phones: []*v1.SipContactPhone{{Number: "+79160000000"}}}, nil)
	o.must(404, "GET", "/api/workspaces/"+uuid.NewString()+"/sip/contacts", nil, nil)
	// A guest: none.
	rid := textRoom(t, o, wid, "general", false)
	link := roomLink(t, o, rid, &v1.CreateRoomInviteRequest{})
	gina := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	gina.must(200, "POST", "/api/room-invites/"+link.GetCode()+"/join", nil, nil)
	gina.must(403, "GET", contacts, nil, nil)

	// Create: numbers normalised (8…, and 10 digits on 9 with a +7 caller ID).
	var cr v1.SipContactResponse
	bob.must(201, "POST", contacts, &v1.SipContactInput{Name: " Анна Петрова ", Company: "ООО Ромашка", Note: "звонить\nпосле 10",
		Phones: []*v1.SipContactPhone{{Number: "8 (916) 111-00-01", Label: v1.SipPhoneLabel_SIP_PHONE_LABEL_MOBILE}, {Number: "(916) 111-00-02"}}}, &cr)
	anna := cr.GetContact()
	if anna.GetName() != "Анна Петрова" || anna.GetCreatedBy() != bob.id || len(anna.GetPhones()) != 2 ||
		anna.GetPhones()[0].GetNumber() != "+79161110001" || anna.GetPhones()[1].GetNumber() != "+79161110002" ||
		anna.GetPhones()[1].GetLabel() != v1.SipPhoneLabel_SIP_PHONE_LABEL_OTHER || anna.GetNote() != "звонить\nпосле 10" {
		t.Fatalf("created: %v", anna)
	}
	for field, in := range map[string]*v1.SipContactInput{
		"name":    {Phones: []*v1.SipContactPhone{{Number: "+79160000009"}}},
		"phones":  {Name: "X", Phones: []*v1.SipContactPhone{{Number: "12345"}}},
		"phones ": {Name: "X", Phones: []*v1.SipContactPhone{{Number: "+79160000009"}, {Number: "89160000009"}}},
		"company": {Name: "X", Company: strings.Repeat("я", 129)},
		"note":    {Name: "X", Note: strings.Repeat("я", 1001)},
	} {
		st, e := bob.apiErrBody("POST", contacts, in)
		if st != 422 || e.GetField() != strings.TrimSpace(field) {
			t.Fatalf("%s: %d %v", field, st, e)
		}
	}
	// A number of one contact only: 409 with who has it.
	var e v1.ApiError
	st := o.do("POST", contacts, &v1.SipContactInput{Company: "ООО Лютик", Phones: []*v1.SipContactPhone{{Number: "+7 916 111-00-02"}}}, nil)
	_ = protojson.Unmarshal(o.lastBody, &e)
	if st != 409 || e.GetCode() != v1.ErrorCode_ERROR_CODE_SIP_CONTACT_NUMBER_TAKEN || e.GetConflictId() != anna.GetId() ||
		e.GetConflictName() != "Анна Петрова" || e.GetField() != "phones" {
		t.Fatalf("taken: %d %v", st, &e)
	}
	o.must(201, "POST", contacts, &v1.SipContactInput{Company: "ООО Лютик", Phones: []*v1.SipContactPhone{{Number: "+74957650000"}}}, &cr)
	lutik := cr.GetContact()
	dave.must(201, "POST", contacts, &v1.SipContactInput{Name: "Zed", Phones: []*v1.SipContactPhone{{Number: "+12125550100"}}}, &cr)
	zed := cr.GetContact()
	bob.must(201, "POST", contacts, &v1.SipContactInput{Name: "123 Склад"}, &cr) // no numbers is fine

	// Edit: anybody with the section; phones as a whole, the own numbers may stay.
	var up v1.SipContactResponse
	dave.must(200, "PATCH", contacts+"/"+anna.GetId(), &v1.UpdateSipContactRequest{Company: strp("ООО «Ромашка»"),
		Phones: &v1.SipContactPhones{Phones: []*v1.SipContactPhone{{Number: "+79161110002", Label: v1.SipPhoneLabel_SIP_PHONE_LABEL_WORK}, {Number: "+79161110003"}}}}, &up)
	if c := up.GetContact(); c.GetName() != "Анна Петрова" || c.GetCompany() != "ООО «Ромашка»" || len(c.GetPhones()) != 2 ||
		c.GetPhones()[0].GetNumber() != "+79161110002" || c.GetUpdatedBy() != dave.id || c.GetNote() == "" {
		t.Fatalf("patched: %v", c)
	}
	bob.wantErr(409, v1.ErrorCode_ERROR_CODE_SIP_CONTACT_NUMBER_TAKEN, "PATCH", contacts+"/"+lutik.GetId(),
		&v1.UpdateSipContactRequest{Phones: &v1.SipContactPhones{Phones: []*v1.SipContactPhone{{Number: "+79161110003"}}}})
	bob.wantErr(422, v1.ErrorCode_ERROR_CODE_VALIDATION, "PATCH", contacts+"/"+lutik.GetId(), &v1.UpdateSipContactRequest{Company: strp("")})
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	o.must(404, "GET", "/api/workspaces/"+other+"/sip/contacts/"+anna.GetId(), nil, nil) // workspace scoping
	o.must(404, "DELETE", "/api/workspaces/"+other+"/sip/contacts/"+anna.GetId(), nil, nil)
	o.wantErr(409, v1.ErrorCode_ERROR_CODE_CONFLICT, "POST", "/api/workspaces/"+other+"/sip/contacts", &v1.SipContactInput{Name: "x"}) // PLAN_LIMIT

	// The list: Cyrillic, then Latin, then the rest; search by text and digits; pages.
	var list v1.ListSipContactsResponse
	bob.must(200, "GET", contacts, nil, &list)
	if got := strings.Join(contactNames(&list), "|"); got != "Анна Петрова|ООО Лютик|Zed|123 Склад" || list.GetNextCursor() != "" {
		t.Fatalf("order: %s", got)
	}
	bob.must(200, "GET", contacts+"?q=ромаш", nil, &list)
	if got := contactNames(&list); len(got) != 1 || got[0] != "Анна Петрова" {
		t.Fatalf("q text: %v", got)
	}
	// Case and ё folded whatever the database's locale (a C-locale lower() keeps Cyrillic capitals).
	bob.must(200, "GET", contacts+"?q="+url.QueryEscape("РОМАШ"), nil, &list)
	if got := contactNames(&list); len(got) != 1 || got[0] != "Анна Петрова" {
		t.Fatalf("q upper: %v", got)
	}
	var folded string
	if err := testDB.Pool.QueryRow(ctx, `SELECT sip_fold('ЁЛКИН Ёлкин ANNA Їжак' COLLATE "C")`).Scan(&folded); err != nil ||
		folded != "елкин елкин anna їжак" {
		t.Fatalf("sip_fold: %q %v", folded, err)
	}
	bob.must(200, "GET", contacts+"?q=%2B1%20212", nil, &list)
	if got := contactNames(&list); len(got) != 1 || got[0] != "Zed" {
		t.Fatalf("q digits: %v", got)
	}
	bob.must(422, "GET", contacts+"?cursor=bad!", nil, nil)

	// The detail: the contact and its calls the reader may see (none yet).
	var gc v1.GetSipContactResponse
	bob.must(200, "GET", contacts+"/"+anna.GetId(), nil, &gc)
	if gc.GetContact().GetId() != anna.GetId() || len(gc.GetCalls()) != 0 {
		t.Fatalf("detail: %v", &gc)
	}

	// Delete: the author or MANAGE_INTEGRATIONS.
	bob.must(403, "DELETE", contacts+"/"+zed.GetId(), nil, nil)
	dave.must(204, "DELETE", contacts+"/"+zed.GetId(), nil, nil)
	o.must(204, "DELETE", contacts+"/"+lutik.GetId(), nil, nil)
	o.must(404, "DELETE", contacts+"/"+lutik.GetId(), nil, nil)

	// Import: MANAGE_INTEGRATIONS; a preview writes nothing; taken numbers and repeats skipped.
	csv := []byte("\xef\xbb\xbfФИО;Компания;Мобильный;Рабочий;Заметка\r\n" +
		"Борис Сидоров;ООО Вектор;8 916 222-00-01;;\r\n" +
		"Дубль;;+79161110002;;\r\n" + // Анна's
		"Вера;;+79162220001;;\r\n" + // Борис's
		";ИП Кузнецов;;+7 495 222-00-03, 9162220004;=HYPERLINK(\"x\")\r\n" +
		"Без номера;;;;\r\n")
	if st, _, e := contactsUpload(t, bob.token, contacts+"/import", csv); st != 403 {
		t.Fatalf("bob imports: %d %v", st, e)
	}
	st, prev, _ := contactsUpload(t, o.token, contacts+"/import?dry_run=1", csv)
	if st != 200 || !prev.GetDryRun() || prev.GetCreated() != 2 || prev.GetRows() != 5 || len(prev.GetSkipped()) != 3 {
		t.Fatalf("preview: %d %v", st, prev)
	}
	if sk := prev.GetSkipped(); sk[0].GetRow() != 3 || sk[0].GetReason() != "number_taken" || sk[0].GetContactId() != anna.GetId() ||
		sk[0].GetContactName() != "Анна Петрова" || sk[1].GetReason() != "duplicate" || sk[1].GetRow() != 4 || sk[2].GetReason() != "no_number" {
		t.Fatalf("skips: %v", sk)
	}
	o.must(200, "GET", contacts, nil, &list)
	if len(list.GetContacts()) != 2 {
		t.Fatalf("a preview wrote: %v", contactNames(&list))
	}
	st, imp, _ := contactsUpload(t, o.token, contacts+"/import", csv)
	if st != 200 || imp.GetDryRun() || imp.GetCreated() != 2 {
		t.Fatalf("import: %d %v", st, imp)
	}
	o.must(200, "GET", contacts+"?q=Кузнецов", nil, &list)
	if len(list.GetContacts()) != 1 || len(list.GetContacts()[0].GetPhones()) != 2 || list.GetContacts()[0].GetNote() != "=HYPERLINK(\"x\")" ||
		list.GetContacts()[0].GetCreatedBy() != o.id {
		t.Fatalf("imported: %v", list.GetContacts())
	}
	var big strings.Builder
	big.WriteString("Имя;Телефон\n")
	for i := range 5001 {
		fmt.Fprintf(&big, "A%d;+7917%07d\n", i, i)
	}
	if st, _, e := contactsUpload(t, o.token, contacts+"/import", []byte(big.String())); st != 422 || e.GetField() != "file" {
		t.Fatalf("5001 rows: %d %v", st, e)
	}
	if st, _, e := contactsUpload(t, o.token, contacts+"/import", bytes.Repeat([]byte("x"), 1<<20+10)); st != 422 || e.GetField() != "file" {
		t.Fatalf("too large: %d %v", st, e)
	}

	// Export: MANAGE_INTEGRATIONS; formulas defused.
	if st, _ := rawGet(t, bob.token, contacts+"/export.csv"); st != 403 {
		t.Fatalf("bob exports: %d", st)
	}
	st, out := rawGet(t, o.token, contacts+"/export.csv")
	if st != 200 || !strings.HasPrefix(out, "\xef\xbb\xbfИмя;Компания;") || !strings.Contains(out, "'+79161110002") ||
		!strings.Contains(out, "'=HYPERLINK") || strings.Contains(out, ";=HYPERLINK") {
		t.Fatalf("export: %d %q", st, out)
	}

	// Bots: by their roles (MANAGE_INTEGRATIONS here) — a CRM sync; without a role, no section.
	b := createBot(t, o, wid, "CRM")
	b.must(403, "GET", contacts, nil, nil)
	mgr := newRole(t, o, wid, "Интеграции", perm.ManageIntegrations|perm.ViewJournals)
	if st, _ := setMemberRoles(o, wid, b.id, mgr.GetId()); st != 200 {
		t.Fatalf("bot role: %d", st)
	}
	b.must(201, "POST", contacts, &v1.SipContactInput{Company: "ООО CRM", Phones: []*v1.SipContactPhone{{Number: "+74950000077"}}}, nil)
	if st, _, e := contactsUpload(t, b.token, contacts+"/import?dry_run=1", csv); st != 200 {
		t.Fatalf("bot import preview: %d %v", st, e)
	}

	// Caller ID: an inbound call from Анна's number names her (a contact), one from bob's phone
	// names bob (an employee) — never to a bot.
	pushHTTP(t, server, o, 200, "PUT", base+"/inbound", &v1.PutSipInboundRequest{Enabled: true,
		Target: &v1.SipRouteTarget{Kind: v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION, Id: bobExt.GetExtension().GetId()}}, nil)
	carol.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Phone: strp("+7 916 333-00-01")}, nil)
	bobG := dialGW(t)
	bobG.identify(bob.token)
	ring := func(number string) *v1.SipCall {
		t.Helper()
		room := rtc.InboundRoomPrefix(uuid.MustParse(wid)) + "_" + number + "_" + uniq("")
		if err := a.SIP.Inbound(ctx, rtc.EventParticipantJoined, room, inboundLine(number)); err != nil {
			t.Fatal(err)
		}
		c := bobG.wait("SIP_INBOUND_RING "+number, func(e *v1.DispatchEvent) bool {
			return e.GetSipInboundRing().GetCall().GetNumber() == number
		}).GetSipInboundRing().GetCall()
		if err := a.SIP.Inbound(ctx, rtc.EventParticipantLeft, room, inboundLine(number)); err != nil {
			t.Fatal(err)
		}
		return c
	}
	if c := ring("+79161110003"); c.GetContactId() != anna.GetId() || c.GetCallerName() != "Анна Петрова" ||
		c.GetCallerCompany() != "ООО «Ромашка»" || c.GetCallerUserId() != "" {
		t.Fatalf("contact caller: %v", c)
	}
	if c := ring("+79163330001"); c.GetContactId() != "" || c.GetCallerUserId() != carol.id {
		t.Fatalf("employee caller: %v", c)
	}
	unknown := ring("+79169999999")
	if unknown.GetCallerName() != "" || unknown.GetContactId() != "" || unknown.GetCallerUserId() != "" {
		t.Fatalf("unknown caller: %v", unknown)
	}
	// The journal names the calls as of now; text search finds by the contact's name.
	var jl v1.ListSipJournalResponse
	waitUntil(t, "three calls in the journal", func() bool {
		o.must(200, "GET", base+"/journal?scope=all", nil, &jl)
		return len(jl.GetEntries()) == 3
	})
	byNumber := map[string]*v1.SipJournalEntry{}
	for _, en := range jl.GetEntries() {
		byNumber[en.GetPeerE164()] = en
	}
	if en := byNumber["+79161110003"]; en.GetContact().GetId() != anna.GetId() || en.GetContact().GetName() != "Анна Петрова" {
		t.Fatalf("journal contact: %v", en)
	}
	if en := byNumber["+79163330001"]; en.GetMemberUserId() != carol.id || en.GetContact() != nil {
		t.Fatalf("journal employee: %v", en)
	}
	o.must(200, "GET", base+"/journal?scope=all&q="+"Ромашка", nil, &jl)
	if len(jl.GetEntries()) != 1 || jl.GetEntries()[0].GetPeerE164() != "+79161110003" {
		t.Fatalf("journal q: %v", jl.GetEntries())
	}
	// A contact added after the call names it too.
	o.must(201, "POST", contacts, &v1.SipContactInput{Name: "Новый", Phones: []*v1.SipContactPhone{{Number: "+79169999999"}}}, &cr)
	o.must(200, "GET", base+"/journal/"+unknown.GetId(), nil, nil)
	var det v1.GetSipJournalEntryResponse
	o.must(200, "GET", base+"/journal/"+unknown.GetId(), nil, &det)
	if det.GetEntry().GetContact().GetName() != "Новый" {
		t.Fatalf("named later: %v", det.GetEntry())
	}
	// A bot reading the journal never learns an employee's phone.
	b.must(200, "GET", base+"/journal?scope=all", nil, &jl)
	for _, en := range jl.GetEntries() {
		if en.GetMemberUserId() != "" {
			t.Fatalf("a bot got member_user_id: %v", en)
		}
	}
	// The contact's calls: bob (rang) sees his; dave (VIEW_JOURNALS) all of them.
	bob.must(200, "GET", contacts+"/"+anna.GetId(), nil, &gc)
	if len(gc.GetCalls()) != 1 || gc.GetCalls()[0].GetPeerE164() != "+79161110003" {
		t.Fatalf("contact calls: %v", gc.GetCalls())
	}

	// Retention: a contact without calls and edits within the period goes; one whose number
	// called within it stays.
	if _, err := testDB.Pool.Exec(ctx, "UPDATE sip_contacts SET updated_at = now() - interval '13 months' WHERE workspace_id = $1", wid); err != nil {
		t.Fatal(err)
	}
	a.SIP.PurgeExpired(ctx, time.Now())
	o.must(200, "GET", contacts, nil, &list)
	names := strings.Join(contactNames(&list), "|")
	if !strings.Contains(names, "Анна Петрова") || !strings.Contains(names, "Новый") || strings.Contains(names, "Борис Сидоров") ||
		strings.Contains(names, "ООО CRM") {
		t.Fatalf("after retention: %s", names)
	}
}
