package sip

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// The phone book of the telephony section (ADR-0137 §2): the workspace's contacts with their
// numbers, so a call shows a company or a person instead of digits. Every member who sees the
// section reads and edits it (the team's shared book), the author or MANAGE_INTEGRATIONS deletes,
// CSV import / export is MANAGE_INTEGRATIONS. A number belongs to one contact.

// Limits of the phone book.
const (
	MaxContacts        = 10_000
	maxContactPhones   = 10
	contactsPage       = 200
	contactNameMax     = 128
	contactNoteMax     = 1000
	contactCallsShown  = 10
	contactWritesHour  = 600 // contact writes per member and hour (bots syncing a CRM import instead)
	contactImportsHour = 20  // imports (and their previews) per workspace and hour
	contactExportsHour = 20  // exports per workspace and hour
)

var phoneLabelToDB = map[v1.SipPhoneLabel]string{
	v1.SipPhoneLabel_SIP_PHONE_LABEL_UNSPECIFIED: "other",
	v1.SipPhoneLabel_SIP_PHONE_LABEL_MOBILE:      "mobile",
	v1.SipPhoneLabel_SIP_PHONE_LABEL_WORK:        "work",
	v1.SipPhoneLabel_SIP_PHONE_LABEL_HOME:        "home",
	v1.SipPhoneLabel_SIP_PHONE_LABEL_OTHER:       "other",
}

var phoneLabelFromDB = map[string]v1.SipPhoneLabel{
	"mobile": v1.SipPhoneLabel_SIP_PHONE_LABEL_MOBILE,
	"work":   v1.SipPhoneLabel_SIP_PHONE_LABEL_WORK,
	"home":   v1.SipPhoneLabel_SIP_PHONE_LABEL_HOME,
	"other":  v1.SipPhoneLabel_SIP_PHONE_LABEL_OTHER,
}

func (s *Service) contactRoutes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/workspaces/{id}/sip/contacts", wrap(httpx.HandlerFunc(s.listContacts)))
	mux.Handle("POST /api/workspaces/{id}/sip/contacts", wrap(httpx.HandlerFunc(s.createContact)))
	mux.Handle("GET /api/workspaces/{id}/sip/contacts/export.csv", wrap(httpx.HandlerFunc(s.exportContacts)))
	mux.Handle("POST /api/workspaces/{id}/sip/contacts/import", wrap(httpx.HandlerFunc(s.importContacts)))
	mux.Handle("GET /api/workspaces/{id}/sip/contacts/{cid}", wrap(httpx.HandlerFunc(s.getContact)))
	mux.Handle("PATCH /api/workspaces/{id}/sip/contacts/{cid}", wrap(httpx.HandlerFunc(s.updateContact)))
	mux.Handle("DELETE /api/workspaces/{id}/sip/contacts/{cid}", wrap(httpx.HandlerFunc(s.deleteContact)))
}

// ---------------------------------------------------------------- who

// sectionUser is a member who sees the telephony section (ADR-0137 §5) with their bits.
type sectionUser struct {
	ws   uuid.UUID
	user uuid.UUID
	bits perm.Bits
}

func (u sectionUser) manager() bool { return u.bits.Has(perm.ManageIntegrations) }

// sectionMember resolves the workspace of the path for a member who sees the telephony section
// — the server's copy of the client's rule (lib/telephonyAccess.ts): not a guest, and
// MANAGE_INTEGRATIONS, or telephony on and PLACE_CALLS, VIEW_JOURNALS or an internal number.
// 404 for non-members, 403 otherwise.
func (s *Service) sectionMember(r *http.Request) (sectionUser, error) {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return sectionUser{}, err
	}
	ctx, me := r.Context(), uid(r)
	bits, role, err := perm.FromContext(ctx).Workspace(ctx, wsID, me)
	if errors.Is(err, perm.ErrNotMember) {
		return sectionUser{}, httpx.NotFound("workspace")
	}
	if err != nil {
		return sectionUser{}, err
	}
	if role == perm.RoleGuest {
		return sectionUser{}, httpx.Forbidden("guests have no telephony section")
	}
	u := sectionUser{ws: wsID, user: me, bits: bits}
	if u.manager() {
		return u, nil
	}
	ws, err := s.db.Q.GetWorkspace(ctx, wsID)
	if err != nil {
		return u, err
	}
	if ws.SipEnabled {
		if bits.Has(perm.PlaceCalls) || bits.Has(perm.ViewJournals) {
			return u, nil
		}
		has, err := s.db.Q.HasSipExtension(ctx, sqlc.HasSipExtensionParams{WorkspaceID: wsID, UserID: &me})
		if err != nil {
			return u, err
		}
		if has {
			return u, nil
		}
	}
	return u, httpx.Forbidden("the telephony section is not available to you")
}

// takeContactWrite spends one of the member's contact writes.
func (s *Service) takeContactWrite(ctx context.Context, u sectionUser) error {
	return s.ContactWriteLimit.Take(ctx, u.ws.String()+":"+u.user.String())
}

// ---------------------------------------------------------------- validation

// contactPhone is a validated number of a contact.
type contactPhone struct {
	ContactID uuid.UUID `json:"contact_id"`
	Number    string    `json:"number"`
	Label     string    `json:"label"`
	Position  int       `json:"position"`
}

// contactIn is a validated contact.
type contactIn struct {
	name, company, note string
	phones              []contactPhone
}

// cleanNote checks a note: valid UTF-8, line breaks and tabs allowed, no other control
// characters, at most n runes; \r\n becomes \n.
func cleanNote(s string, n int) (string, bool) {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n"))
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > n {
		return "", false
	}
	for _, r := range s {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return "", false
		}
	}
	return s, true
}

func validateContact(name, company, note string, phones []*v1.SipContactPhone, callerID string) (contactIn, error) {
	var in contactIn
	var ok bool
	if in.name, ok = cleanText(name, contactNameMax); !ok {
		return in, httpx.Validation("name", "the name is up to 128 characters")
	}
	if in.company, ok = cleanText(company, contactNameMax); !ok {
		return in, httpx.Validation("company", "the company is up to 128 characters")
	}
	if in.name == "" && in.company == "" {
		return in, httpx.Validation("name", "a name or a company is required")
	}
	if in.note, ok = cleanNote(note, contactNoteMax); !ok {
		return in, httpx.Validation("note", "the note is up to 1000 characters")
	}
	var err error
	if in.phones, err = validatePhones(phones, callerID); err != nil {
		return in, err
	}
	return in, nil
}

func validatePhones(phones []*v1.SipContactPhone, callerID string) ([]contactPhone, error) {
	if len(phones) > maxContactPhones {
		return nil, httpx.Validation("phones", "at most 10 numbers per contact")
	}
	out := make([]contactPhone, 0, len(phones))
	seen := map[string]bool{}
	for i, p := range phones {
		n, ok := NormalizeContactNumber(p.GetNumber(), callerID)
		if !ok {
			return nil, httpx.Validation("phones", "not a phone number: use the international format, e.g. +7 916 123-45-67")
		}
		if seen[n] {
			return nil, httpx.Validation("phones", "the same number is listed twice")
		}
		seen[n] = true
		label, ok := phoneLabelToDB[p.GetLabel()]
		if !ok {
			return nil, httpx.Validation("phones", "unknown number label")
		}
		out = append(out, contactPhone{Number: n, Label: label, Position: i})
	}
	return out, nil
}

// numberTaken is 409 SIP_CONTACT_NUMBER_TAKEN for the contact that has number.
func numberTaken(number string, owner sqlc.SipContactNumberOwnersRow) error {
	name := displayName(owner.Name, owner.Company)
	e := httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_SIP_CONTACT_NUMBER_TAKEN, number+" already belongs to «"+name+"»")
	e.Field, e.ConflictID, e.ConflictName = "phones", owner.ID.String(), name
	return e
}

func displayName(name, company string) string {
	if name != "" {
		return name
	}
	return company
}

// checkNumbersFree refuses numbers another contact of the workspace has (self: the contact
// being edited).
func checkNumbersFree(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, phones []contactPhone, self *uuid.UUID) error {
	if len(phones) == 0 {
		return nil
	}
	numbers := make([]string, len(phones))
	for i, p := range phones {
		numbers[i] = p.Number
	}
	owners, err := q.SipContactNumberOwners(ctx, sqlc.SipContactNumberOwnersParams{WorkspaceID: ws, Numbers: numbers})
	if err != nil {
		return err
	}
	for _, n := range numbers { // in the request's order: the first taken one is named
		for _, o := range owners {
			if o.Number == n && (self == nil || o.ID != *self) {
				return numberTaken(n, o)
			}
		}
	}
	return nil
}

func insertPhones(ctx context.Context, q *sqlc.Queries, ws, contact uuid.UUID, phones []contactPhone) error {
	if len(phones) == 0 {
		return nil
	}
	for i := range phones {
		phones[i].ContactID = contact
	}
	raw, err := json.Marshal(phones)
	if err != nil {
		return err
	}
	return q.InsertSipContactPhones(ctx, sqlc.InsertSipContactPhonesParams{WorkspaceID: ws, Phones: raw})
}

// ---------------------------------------------------------------- reading

func contactPB(c sqlc.SipContact, phones []sqlc.SipContactPhone) *v1.SipContact {
	out := &v1.SipContact{Id: c.ID.String(), WorkspaceId: c.WorkspaceID.String(), Name: c.Name, Company: c.Company, Note: c.Note,
		CreatedBy: idString(c.CreatedBy), UpdatedBy: idString(c.UpdatedBy), CreatedAt: timestamppb.New(c.CreatedAt),
		UpdatedAt: timestamppb.New(c.UpdatedAt), Phones: make([]*v1.SipContactPhone, 0, len(phones))}
	for _, p := range phones {
		out.Phones = append(out.Phones, &v1.SipContactPhone{Number: p.Number, Label: phoneLabelFromDB[p.Label]})
	}
	return out
}

// contactsPB converts contacts with their numbers (one query for the numbers).
func (s *Service) contactsPB(ctx context.Context, q *sqlc.Queries, cs []sqlc.SipContact) ([]*v1.SipContact, error) {
	out := make([]*v1.SipContact, 0, len(cs))
	if len(cs) == 0 {
		return out, nil
	}
	ids := make([]uuid.UUID, len(cs))
	for i, c := range cs {
		ids[i] = c.ID
	}
	phones, err := q.ListSipContactPhones(ctx, ids)
	if err != nil {
		return nil, err
	}
	by := map[uuid.UUID][]sqlc.SipContactPhone{}
	for _, p := range phones {
		by[p.ContactID] = append(by[p.ContactID], p)
	}
	for _, c := range cs {
		out = append(out, contactPB(c, by[c.ID]))
	}
	return out, nil
}

// contactCursor is the page key of the phone book (opaque to clients).
type contactCursor struct {
	Group int16     `json:"g"`
	Key   string    `json:"k"`
	ID    uuid.UUID `json:"i"`
}

func encodeContactCursor(c sqlc.SipContact) string {
	cur := contactCursor{ID: c.ID}
	if c.SortGroup != nil {
		cur.Group = *c.SortGroup
	}
	if c.SortKey != nil {
		cur.Key = *c.SortKey
	}
	raw, _ := json.Marshal(cur)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeContactCursor(v string) (contactCursor, bool) {
	var c contactCursor
	if len(v) > 1024 {
		return c, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(v)
	if err != nil || json.Unmarshal(raw, &c) != nil || c.ID == uuid.Nil {
		return c, false
	}
	return c, true
}

// splitQuery reads a search: digits when it has no letters (a number typed with spaces, dashes,
// «+»), otherwise a text (≤ 64 characters).
func splitQuery(q string) (text, digits string) {
	q = strings.TrimSpace(q)
	if q == "" {
		return "", ""
	}
	var b strings.Builder
	for _, r := range q {
		switch {
		case r >= '0' && r <= '9':
			if b.Len() < 16 {
				b.WriteRune(r)
			}
		case strings.ContainsRune("+-() . ", r):
		default:
			return clip(q, 64), ""
		}
	}
	return "", b.String()
}

func (s *Service) listContacts(w http.ResponseWriter, r *http.Request) error {
	u, err := s.sectionMember(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	text, digits := splitQuery(r.URL.Query().Get("q"))
	p := sqlc.ListSipContactsParams{WorkspaceID: u.ws, Text: text, Digits: digits, Lim: contactsPage + 1}
	if v := r.URL.Query().Get("cursor"); v != "" {
		c, ok := decodeContactCursor(v)
		if !ok {
			return httpx.Validation("cursor", "bad cursor")
		}
		p.After, p.CursorGroup, p.CursorKey, p.CursorID = true, c.Group, c.Key, c.ID
	}
	rows, err := s.db.Q.ListSipContacts(ctx, p)
	if err != nil {
		return err
	}
	out := &v1.ListSipContactsResponse{}
	if len(rows) > contactsPage {
		rows = rows[:contactsPage]
		out.NextCursor = encodeContactCursor(rows[len(rows)-1])
	}
	if out.Contacts, err = s.contactsPB(ctx, s.db.Q, rows); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func (s *Service) contactOf(r *http.Request, ws uuid.UUID) (sqlc.SipContact, error) {
	cid, err := httpx.PathUUID(r, "cid", "contact")
	if err != nil {
		return sqlc.SipContact{}, err
	}
	c, err := s.db.Q.GetSipContact(r.Context(), sqlc.GetSipContactParams{WorkspaceID: ws, ID: cid})
	if db.IsNotFound(err) {
		return c, httpx.NotFound("contact")
	}
	return c, err
}

func (s *Service) getContact(w http.ResponseWriter, r *http.Request) error {
	u, err := s.sectionMember(r)
	if err != nil {
		return err
	}
	c, err := s.contactOf(r, u.ws)
	if err != nil {
		return err
	}
	ctx := r.Context()
	pbs, err := s.contactsPB(ctx, s.db.Q, []sqlc.SipContact{c})
	if err != nil {
		return err
	}
	out := &v1.GetSipContactResponse{Contact: pbs[0], Calls: []*v1.SipJournalEntry{}}
	numbers := make([]string, 0, len(pbs[0].GetPhones()))
	for _, p := range pbs[0].GetPhones() {
		numbers = append(numbers, p.GetNumber())
	}
	if len(numbers) > 0 {
		if out.Calls, err = s.contactCalls(ctx, u, numbers); err != nil {
			return err
		}
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// contactCalls are the last calls with numbers the reader may see in the journal: every call of
// the workspace for VIEW_JOURNALS (calls of rooms they cannot view left out), their own otherwise.
func (s *Service) contactCalls(ctx context.Context, u sectionUser, numbers []string) ([]*v1.SipJournalEntry, error) {
	var rows []sqlc.SipCall
	var err error
	if u.bits.Has(perm.ViewJournals) {
		rows, err = s.db.Q.ListSipJournal(ctx, sqlc.ListSipJournalParams{WorkspaceID: u.ws, ByPeers: true, Peers: numbers,
			Lim: contactCallsShown * 3})
		if err == nil {
			visible := rows[:0:0]
			res := perm.FromContext(ctx)
			for _, c := range rows {
				ok, err := roomVisible(ctx, res, c.RoomID, u.user)
				if err != nil {
					return nil, err
				}
				if ok && len(visible) < contactCallsShown {
					visible = append(visible, c)
				}
			}
			rows = visible
		}
	} else {
		rows, err = s.db.Q.ListSipJournalForUser(ctx, sqlc.ListSipJournalForUserParams{WorkspaceID: u.ws, UserID: u.user,
			ByPeers: true, Peers: numbers, Lim: contactCallsShown})
	}
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return []*v1.SipJournalEntry{}, nil
	}
	out, err := s.entries(ctx, rows)
	if err != nil {
		return nil, err
	}
	if auth.MustFromContext(ctx).IsBot {
		hideMembers(out)
	}
	return out, nil
}

// ---------------------------------------------------------------- writing

func (s *Service) createContact(w http.ResponseWriter, r *http.Request) error {
	u, err := s.sectionMember(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.planAllows(ctx, u.ws); err != nil {
		return err
	}
	var req v1.SipContactInput
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	a, _, err := s.account(ctx, s.db.Q, u.ws)
	if err != nil {
		return err
	}
	in, err := validateContact(req.GetName(), req.GetCompany(), req.GetNote(), req.GetPhones(), a.CallerID)
	if err != nil {
		return err
	}
	if err := s.takeContactWrite(ctx, u); err != nil {
		return err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	var out *v1.SipContact
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.LockSipContacts(ctx, u.ws); err != nil {
			return err
		}
		if n, err := q.CountSipContacts(ctx, u.ws); err != nil {
			return err
		} else if n >= MaxContacts {
			return httpx.Conflict("the phone book holds 10 000 contacts at most")
		}
		if err := checkNumbersFree(ctx, q, u.ws, in.phones, nil); err != nil {
			return err
		}
		c, err := q.InsertSipContact(ctx, sqlc.InsertSipContactParams{ID: id, WorkspaceID: u.ws, Name: in.name, Company: in.company,
			Note: in.note, CreatedBy: &u.user})
		if err != nil {
			return err
		}
		if err := insertPhones(ctx, q, u.ws, id, in.phones); err != nil {
			return err
		}
		pbs, err := s.contactsPB(ctx, q, []sqlc.SipContact{c})
		if err == nil {
			out = pbs[0]
		}
		return err
	})
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: contact created", "workspace", u.ws, "contact", id, "by", u.user, "numbers", len(in.phones))
	httpx.Write(w, http.StatusCreated, &v1.SipContactResponse{Contact: out})
	return nil
}

func (s *Service) updateContact(w http.ResponseWriter, r *http.Request) error {
	u, err := s.sectionMember(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.planAllows(ctx, u.ws); err != nil {
		return err
	}
	cid, err := httpx.PathUUID(r, "cid", "contact")
	if err != nil {
		return err
	}
	var req v1.UpdateSipContactRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	a, _, err := s.account(ctx, s.db.Q, u.ws)
	if err != nil {
		return err
	}
	if err := s.takeContactWrite(ctx, u); err != nil {
		return err
	}
	var out *v1.SipContact
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.LockSipContacts(ctx, u.ws); err != nil {
			return err
		}
		cur, err := q.GetSipContactForUpdate(ctx, sqlc.GetSipContactForUpdateParams{WorkspaceID: u.ws, ID: cid})
		if db.IsNotFound(err) {
			return httpx.NotFound("contact")
		}
		if err != nil {
			return err
		}
		name, company, note := cur.Name, cur.Company, cur.Note
		if req.Name != nil {
			name = req.GetName()
		}
		if req.Company != nil {
			company = req.GetCompany()
		}
		if req.Note != nil {
			note = req.GetNote()
		}
		in, err := validateContact(name, company, note, req.GetPhones().GetPhones(), a.CallerID)
		if err != nil {
			return err
		}
		if req.Phones != nil {
			if err := checkNumbersFree(ctx, q, u.ws, in.phones, &cid); err != nil {
				return err
			}
			if err := q.DeleteSipContactPhones(ctx, sqlc.DeleteSipContactPhonesParams{WorkspaceID: u.ws, ContactID: cid}); err != nil {
				return err
			}
			if err := insertPhones(ctx, q, u.ws, cid, in.phones); err != nil {
				return err
			}
		}
		c, err := q.UpdateSipContact(ctx, sqlc.UpdateSipContactParams{WorkspaceID: u.ws, ID: cid, Name: in.name, Company: in.company,
			Note: in.note, UpdatedBy: &u.user})
		if err != nil {
			return err
		}
		pbs, err := s.contactsPB(ctx, q, []sqlc.SipContact{c})
		if err == nil {
			out = pbs[0]
		}
		return err
	})
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: contact updated", "workspace", u.ws, "contact", cid, "by", u.user)
	httpx.Write(w, http.StatusOK, &v1.SipContactResponse{Contact: out})
	return nil
}

func (s *Service) deleteContact(w http.ResponseWriter, r *http.Request) error {
	u, err := s.sectionMember(r)
	if err != nil {
		return err
	}
	c, err := s.contactOf(r, u.ws)
	if err != nil {
		return err
	}
	if !u.manager() && (c.CreatedBy == nil || *c.CreatedBy != u.user) {
		return httpx.Forbidden("only the author or MANAGE_INTEGRATIONS may delete this contact")
	}
	ctx := r.Context()
	if err := s.takeContactWrite(ctx, u); err != nil {
		return err
	}
	if err := db.GuardExec(ctx, s.db, func(q *sqlc.Queries) error {
		_, err := q.DeleteSipContact(ctx, sqlc.DeleteSipContactParams{WorkspaceID: u.ws, ID: c.ID})
		return err
	}); err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: contact deleted", "workspace", u.ws, "contact", c.ID, "by", u.user)
	w.WriteHeader(http.StatusNoContent)
	return nil
}
