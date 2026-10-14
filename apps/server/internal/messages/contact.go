package messages

import (
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

// Contact requests of bots (ADR-0100): a REQUEST_CONTACT inline button in the bot's DM with a
// person; the person confirms on their client and the server sends the contact from the profile.

const (
	// MaxContactReason bounds InlineButton.reason of a REQUEST_CONTACT button (characters).
	MaxContactReason = 120
	// ContactSharesPerHour bounds the shares of one person over all bots.
	ContactSharesPerHour = 10

	// ReasonContactDMOnly marks a REQUEST_CONTACT button outside a DM (400).
	ReasonContactDMOnly = "BOT_CONTACT_REQUEST_DM_ONLY"
	// ReasonContactShared marks a person who already shared through this button (409).
	ReasonContactShared = "CONTACT_ALREADY_SHARED"
	// ReasonContactEmpty marks a share where none of the requested fields is set in the profile (422).
	ReasonContactEmpty = "CONTACT_EMPTY"
	// ReasonContactLimit marks more than ContactSharesPerHour shares in an hour (429).
	ReasonContactLimit = "CONTACT_SHARE_LIMIT"
)

// contactFieldNames are the stored names of the fields (bot_contact_shares.fields), in order.
var contactFieldNames = map[v1.ContactField]string{v1.ContactField_CONTACT_FIELD_PHONE: "phone", v1.ContactField_CONTACT_FIELD_EMAIL: "email"}

// validContactButton checks the kind-specific fields of a button: a callback button has no
// fields or reason; a REQUEST_CONTACT button asks for one or two distinct fields with a short
// reason without control characters.
func validContactButton(b *v1.InlineButton) bool {
	switch b.GetKind() {
	case v1.InlineButtonKind_INLINE_BUTTON_KIND_UNSPECIFIED:
		return len(b.GetFields()) == 0 && b.GetReason() == ""
	case v1.InlineButtonKind_INLINE_BUTTON_KIND_REQUEST_CONTACT:
		if len(b.GetFields()) == 0 || len(b.GetFields()) > 2 {
			return false
		}
		seen := map[v1.ContactField]bool{}
		for _, f := range b.GetFields() {
			if contactFieldNames[f] == "" || seen[f] {
				return false
			}
			seen[f] = true
		}
		return utf8.RuneCountInString(b.GetReason()) <= MaxContactReason && !strings.ContainsFunc(b.GetReason(), unicode.IsControl)
	}
	return false
}

// hasContactRequest reports whether a keyboard has a REQUEST_CONTACT button.
func hasContactRequest(k *v1.InlineKeyboard) bool {
	for _, row := range k.GetRows() {
		for _, b := range row.GetButtons() {
			if b.GetKind() == v1.InlineButtonKind_INLINE_BUTTON_KIND_REQUEST_CONTACT {
				return true
			}
		}
	}
	return false
}

// contactDMOnly rejects a REQUEST_CONTACT button outside a DM (ADR-0100 §1). A bot's DM is
// always with a person.
func contactDMOnly(k *v1.InlineKeyboard, acc perm.RoomAccess) error {
	if hasContactRequest(k) && !acc.DM {
		return httpx.BadRequest("contact requests are allowed only in a direct message").WithDetails(ReasonContactDMOnly, 0, 0)
	}
	return nil
}

// contactButton finds a live REQUEST_CONTACT button of the saved keyboard.
func contactButton(m sqlc.Message, user uuid.UUID, id string) (*v1.InlineButton, error) {
	unavailable := httpx.Conflict("button is unavailable").WithDetails("BUTTON_UNAVAILABLE", 0, 0)
	if len(m.InlineKeyboard) == 0 {
		return nil, unavailable
	}
	var k v1.InlineKeyboard
	if err := protojson.Unmarshal(m.InlineKeyboard, &k); err != nil {
		return nil, err
	}
	if len(k.GetAllowedUserIds()) > 0 && !slices.Contains(k.GetAllowedUserIds(), user.String()) {
		return nil, httpx.Forbidden("this keyboard belongs to another user")
	}
	for _, row := range k.GetRows() {
		for _, b := range row.GetButtons() {
			if b.GetId() == id && !b.GetDisabled() && b.GetKind() == v1.InlineButtonKind_INLINE_BUTTON_KIND_REQUEST_CONTACT {
				return b, nil
			}
		}
	}
	return nil, unavailable
}

// composeContact builds the contact from the profile: the requested fields that are set, in
// the order PHONE, EMAIL. Never from the request.
func composeContact(u sqlc.User, requested []v1.ContactField) (*v1.ContactShared, []v1.ContactField) {
	c := &v1.ContactShared{UserId: u.ID.String(), DisplayName: u.DisplayName}
	want := map[v1.ContactField]bool{}
	for _, f := range requested {
		want[f] = true
	}
	var fields []v1.ContactField
	if want[v1.ContactField_CONTACT_FIELD_PHONE] && u.Phone != nil && *u.Phone != "" {
		c.Phone = *u.Phone
		c.PhoneVerified = false // no phone verification in the product yet (ADR-0100 §5)
		fields = append(fields, v1.ContactField_CONTACT_FIELD_PHONE)
	}
	if want[v1.ContactField_CONTACT_FIELD_EMAIL] && u.Email != nil && *u.Email != "" {
		c.Email = *u.Email
		c.EmailVerified = u.EmailVerifiedAt != nil
		fields = append(fields, v1.ContactField_CONTACT_FIELD_EMAIL)
	}
	c.Fields = fields
	return c, fields
}

func (h *Handlers) shareContact(w http.ResponseWriter, r *http.Request) error {
	if auth.MustFromContext(r.Context()).IsBot {
		return httpx.Forbidden("only people can share their contact")
	}
	id, err := httpx.PathUUID(r, "id", "message")
	if err != nil {
		return err
	}
	buttonIDValue := r.PathValue("buttonId")
	if !buttonID.MatchString(buttonIDValue) {
		return httpx.Validation("buttonId", "invalid button id")
	}
	ctx, user := r.Context(), uid(r)
	var (
		event   *v1.DispatchEvent
		botID   uuid.UUID
		sys     sqlc.Message
		acc     perm.RoomAccess
		share   sqlc.BotContactShare
		fields  []v1.ContactField
		limited bool
	)
	err = h.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.LockContactShareUser(ctx, user); err != nil {
			return err
		}
		m, err := q.GetMessageForInteraction(ctx, id)
		if db.IsNotFound(err) {
			return httpx.NotFound("message")
		}
		if err != nil {
			return err
		}
		var bot sqlc.Bot
		if acc, bot, err = callbackAccess(ctx, q, m, user); err != nil {
			return err
		}
		if !acc.DM {
			return httpx.BadRequest("contact requests are allowed only in a direct message").WithDetails(ReasonContactDMOnly, 0, 0)
		}
		if m.Kind == pbconv.MessageKindSystem || m.StickerID != nil || m.ForwardSentAt != nil {
			return httpx.Forbidden("message has no active buttons")
		}
		button, err := contactButton(m, user, buttonIDValue)
		if err != nil {
			return err
		}
		dup, err := q.ContactShareExists(ctx, sqlc.ContactShareExistsParams{MessageID: m.ID, ButtonID: button.GetId(), UserID: user})
		if err != nil {
			return err
		}
		if dup {
			return httpx.Conflict("contact already shared through this button").WithDetails(ReasonContactShared, 0, 0)
		}
		recent, err := q.CountRecentContactShares(ctx, user)
		if err != nil {
			return err
		}
		if recent >= ContactSharesPerHour {
			limited = true
			return nil
		}
		person, err := q.GetUser(ctx, user)
		if err != nil {
			return err
		}
		var contact *v1.ContactShared
		contact, fields = composeContact(person, button.GetFields())
		if len(fields) == 0 {
			return httpx.Validation("fields", "none of the requested contact fields is set in the profile").WithDetails(ReasonContactEmpty, 0, 0)
		}
		names := make([]string, len(fields))
		for i, f := range fields {
			names[i] = contactFieldNames[f]
		}
		share, err = q.InsertContactShare(ctx, sqlc.InsertContactShareParams{WorkspaceID: bot.WorkspaceID, BotUserID: bot.UserID, UserID: user, RoomID: m.RoomID, MessageID: m.ID, ButtonID: button.GetId(), Fields: names})
		if err != nil {
			return err
		}
		raw, err := protojson.Marshal(&v1.SystemMessage{Payload: &v1.SystemMessage_ContactShared{ContactShared: &v1.ContactSharedCard{
			BotUserId: bot.UserID.String(), Fields: fields, MessageId: m.ID.String(), ButtonId: button.GetId(),
		}}})
		if err != nil {
			return err
		}
		if sys, err = q.InsertSystemMessage(ctx, sqlc.InsertSystemMessageParams{RoomID: m.RoomID, AuthorID: user, Payload: raw}); err != nil {
			return err
		}
		if _, err := q.UpsertReadState(ctx, sqlc.UpsertReadStateParams{UserID: user, RoomID: m.RoomID, LastReadMessageID: sys.ID}); err != nil {
			return err
		}
		botID = bot.UserID
		contact.Id, contact.BotUserId, contact.SharedAt = share.ID.String(), botID.String(), timestamppb.New(share.CreatedAt)
		contact.RoomId, contact.MessageId, contact.ButtonId, contact.Data = m.RoomID.String(), m.ID.String(), button.GetId(), button.GetData()
		event = &v1.DispatchEvent{Event: &v1.DispatchEvent_ContactShared{ContactShared: contact}}
		// The webhook delivery is committed with the share (as BOT_CALLBACK, ADR-0047); the
		// webhook decorator of Publisher.User does not enqueue CONTACT_SHARED again.
		if bot.WebhookUrl != nil && bot.WebhookDisabledAt == nil {
			payload, err := protojson.Marshal(&v1.BotWebhookUpdate{Id: share.ID.String(), BotUserId: botID.String(), CreatedAt: timestamppb.New(share.CreatedAt), Event: event})
			if err != nil {
				return err
			}
			return q.EnqueueWebhookDeliveries(ctx, sqlc.EnqueueWebhookDeliveriesParams{Ids: []uuid.UUID{share.ID}, BotIds: []uuid.UUID{botID}, Payloads: [][]byte{payload}})
		}
		return nil
	})
	if err != nil {
		return err
	}
	if limited {
		return httpx.RateLimited().WithDetails(ReasonContactLimit, ContactSharesPerHour, ContactSharesPerHour)
	}
	h.events.User(ctx, botID, event) // that bot only; best effort after the commit
	out, err := h.details(ctx, []sqlc.Message{sys}, user)
	if err != nil {
		return err
	}
	rooms.Publish(ctx, h.events, acc, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{MessageCreate: &v1.MessageCreate{Message: forEvent(out[0])}}})
	h.events.User(ctx, user, &v1.DispatchEvent{Event: &v1.DispatchEvent_ReadStateUpdate{
		ReadStateUpdate: &v1.ReadStateUpdate{ReadState: &v1.ReadState{RoomId: sys.RoomID.String(), LastReadMessageId: sys.ID.String()}},
	}})
	httpx.Write(w, http.StatusOK, &v1.ShareContactResponse{ShareId: share.ID.String(), Fields: fields, Message: out[0]})
	return nil
}

// listContactShares: the journal of contacts shared with the workspace's bots (VIEW_JOURNALS;
// people only), newest first, without the values.
func (h *Handlers) listContactShares(w http.ResponseWriter, r *http.Request) error {
	if auth.MustFromContext(r.Context()).IsBot {
		return httpx.Forbidden("only people can read journals")
	}
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	bits, role, err := perm.FromContext(r.Context()).Workspace(r.Context(), wsID, uid(r))
	if errors.Is(err, perm.ErrNotMember) {
		return httpx.NotFound("workspace")
	}
	if err != nil {
		return err
	}
	if role == perm.RoleGuest || !bits.Has(perm.ViewJournals) {
		return httpx.Forbidden("VIEW_JOURNALS required")
	}
	limit := 50
	if s := r.URL.Query().Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > 100 {
			return httpx.Validation("limit", "limit must be 1..100")
		}
		limit = n
	}
	var before *uuid.UUID
	if s := r.URL.Query().Get("before"); s != "" {
		b, err := uuid.Parse(s)
		if err != nil {
			return httpx.Validation("before", "invalid cursor")
		}
		before = &b
	}
	rows, err := h.db.Q.ListContactShares(r.Context(), sqlc.ListContactSharesParams{WorkspaceID: wsID, Limit: int32(limit + 1), Before: before}) //nolint:gosec // bounded above
	if err != nil {
		return err
	}
	resp := &v1.ListBotContactSharesResponse{}
	if len(rows) > limit {
		rows, resp.HasMore = rows[:limit], true
	}
	byName := map[string]v1.ContactField{"phone": v1.ContactField_CONTACT_FIELD_PHONE, "email": v1.ContactField_CONTACT_FIELD_EMAIL}
	for _, s := range rows {
		e := &v1.BotContactShareEntry{Id: s.ID.String(), BotUserId: s.BotUserID.String(), UserId: s.UserID.String(), SharedAt: timestamppb.New(s.CreatedAt)}
		for _, f := range s.Fields {
			e.Fields = append(e.Fields, byName[f])
		}
		resp.Entries = append(resp.Entries, e)
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}
