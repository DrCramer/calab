package messages

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"slices"
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
	"github.com/calaba/calaba/server/internal/dms"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

var buttonID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// encodeKeyboard bounds public callback metadata. An explicitly empty keyboard removes it.
func encodeKeyboard(k *v1.InlineKeyboard) ([]byte, error) {
	if k == nil {
		return nil, nil
	}
	invalid := func() ([]byte, error) {
		return nil, httpx.Validation("inlineKeyboard", "invalid keyboard: at most 5 rows of 5 unique buttons and 50 users")
	}
	if len(k.GetRows()) > 5 || len(k.GetAllowedUserIds()) > 50 {
		return invalid()
	}
	users := map[uuid.UUID]bool{}
	for _, raw := range k.GetAllowedUserIds() {
		id, err := uuid.Parse(raw)
		if err != nil || id == uuid.Nil || id.String() != raw || users[id] {
			return invalid()
		}
		users[id] = true
	}
	ids := map[string]bool{}
	for _, row := range k.GetRows() {
		if len(row.GetButtons()) == 0 || len(row.GetButtons()) > 5 {
			return invalid()
		}
		for _, b := range row.GetButtons() {
			if !buttonID.MatchString(b.GetId()) || ids[b.GetId()] || strings.TrimSpace(b.GetLabel()) == "" || utf8.RuneCountInString(b.GetLabel()) > 80 || strings.ContainsFunc(b.GetLabel(), unicode.IsControl) || len(b.GetData()) > 512 || !validContactButton(b) {
				return invalid()
			}
			ids[b.GetId()] = true
		}
	}
	if len(k.GetRows()) == 0 {
		return nil, nil
	}
	return protojson.Marshal(k)
}

func callbackButton(m sqlc.Message, user uuid.UUID, req *v1.CreateMessageInteractionRequest) (*v1.InlineButton, error) {
	if req.GetKeyboardRevision() != uint64(m.KeyboardRevision) || len(m.InlineKeyboard) == 0 { //nolint:gosec // nonnegative DB constraint
		return nil, httpx.Conflict("keyboard changed; reload the message").WithDetails("KEYBOARD_STALE", 0, 0)
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
			// A REQUEST_CONTACT button is confirmed through …/buttons/{id}/contact (ADR-0100).
			if b.GetId() == req.GetButtonId() && !b.GetDisabled() && b.GetKind() == v1.InlineButtonKind_INLINE_BUTTON_KIND_UNSPECIFIED {
				return b, nil
			}
		}
	}
	return nil, httpx.Conflict("button is unavailable").WithDetails("BUTTON_UNAVAILABLE", 0, 0)
}

// callbackAccess uses a new transaction-bound resolver, including task boards and DMs.
func callbackAccess(ctx context.Context, q *sqlc.Queries, m sqlc.Message, user uuid.UUID) (perm.RoomAccess, sqlc.Bot, error) {
	res := perm.NewResolver(q)
	acc, err := res.Room(ctx, m.RoomID, user)
	if errors.Is(err, perm.ErrNoRoom) || (err == nil && !acc.Bits.Has(perm.ViewRoom)) {
		return acc, sqlc.Bot{}, httpx.NotFound("message")
	}
	if err != nil {
		return acc, sqlc.Bot{}, err
	}
	if !acc.Bits.Has(perm.SendMessages) || acc.Suspended {
		return acc, sqlc.Bot{}, httpx.Forbidden("SEND_MESSAGES required")
	}
	if acc.DM {
		since, err := q.GetDMClearedBefore(ctx, sqlc.GetDMClearedBeforeParams{RoomID: m.RoomID, UserID: user})
		if err != nil {
			return acc, sqlc.Bot{}, err
		}
		if since != uuid.Nil && bytes.Compare(m.ID[:], since[:]) <= 0 {
			return acc, sqlc.Bot{}, httpx.NotFound("message")
		}
	}
	bot, err := q.GetBotForUpdate(ctx, m.AuthorID)
	if db.IsNotFound(err) || (err == nil && (bot.TokenHash == nil || bot.RevokedAt != nil)) {
		return acc, bot, httpx.Forbidden("bot unavailable")
	}
	if err != nil {
		return acc, bot, err
	}
	account, err := q.GetUser(ctx, m.AuthorID)
	if err != nil {
		return acc, bot, err
	}
	if account.DisabledAt != nil {
		return acc, bot, httpx.Forbidden("bot unavailable")
	}
	botAcc, err := res.Room(ctx, m.RoomID, m.AuthorID)
	if errors.Is(err, perm.ErrNoRoom) || (err == nil && !botAcc.Bits.Has(perm.ViewRoom)) {
		return acc, bot, httpx.Forbidden("bot cannot access this room")
	}
	if err != nil {
		return acc, bot, err
	}
	if acc.DM {
		if err := dms.CheckBotDM(ctx, q, m.AuthorID, user); err != nil {
			return acc, bot, err
		}
	}
	blocked, err := q.IsBotBlocked(ctx, sqlc.IsBotBlockedParams{UserID: user, BotUserID: m.AuthorID})
	if err != nil {
		return acc, bot, err
	}
	if blocked {
		return acc, bot, httpx.Forbidden("bot is blocked")
	}
	return acc, bot, nil
}

func (h *Handlers) interact(w http.ResponseWriter, r *http.Request) error {
	if auth.MustFromContext(r.Context()).IsBot {
		return httpx.Forbidden("only people can press bot buttons")
	}
	id, err := httpx.PathUUID(r, "id", "message")
	if err != nil {
		return err
	}
	var req v1.CreateMessageInteractionRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if !buttonID.MatchString(req.GetButtonId()) || len(req.GetNonce()) == 0 || len(req.GetNonce()) > MaxNonce || req.GetKeyboardRevision() == 0 || req.GetKeyboardRevision() > math.MaxInt64 {
		return httpx.Validation("buttonId", "button id, keyboard revision and nonce are required")
	}
	ctx, user := r.Context(), uid(r)
	var receipt sqlc.MessageInteraction
	var event *v1.DispatchEvent
	var botID uuid.UUID
	var closed *sqlc.Message // a consent invitation the click closed (ADR-0111)
	err = h.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.LockInteractionNonce(ctx, user.String()+":"+req.GetNonce()); err != nil {
			return err
		}
		m, err := q.GetMessageForInteraction(ctx, id)
		if db.IsNotFound(err) {
			return httpx.NotFound("message")
		}
		if err != nil {
			return err
		}
		acc, bot, err := callbackAccess(ctx, q, m, user)
		if err != nil {
			return err
		}
		botID = bot.UserID
		prev, err := q.GetInteraction(ctx, sqlc.GetInteractionParams{UserID: user, Nonce: req.GetNonce()})
		if err == nil {
			if prev.MessageID != m.ID || prev.ButtonID != req.GetButtonId() || uint64(prev.KeyboardRevision) != req.GetKeyboardRevision() { //nolint:gosec // validated on insertion
				return httpx.Conflict("nonce already used for another interaction")
			}
			receipt = prev
			return nil // accepted receipt survives keyboard edits; no second delivery
		}
		if !db.IsNotFound(err) {
			return err
		}
		if m.Kind == "system" || m.StickerID != nil || m.ForwardSentAt != nil {
			return httpx.Forbidden("message has no active buttons")
		}
		button, err := callbackButton(m, user, &req)
		if err != nil {
			return err
		}
		inv, isInvite, err := delegationInvite(ctx, q, m)
		if err != nil {
			return err
		}
		if err := h.limiter.Take(ctx, "interaction:"+user.String()); err != nil {
			return err
		}
		receipt, err = q.InsertInteraction(ctx, sqlc.InsertInteractionParams{MessageID: m.ID, UserID: user, Nonce: req.GetNonce(), ButtonID: button.GetId(), KeyboardRevision: m.KeyboardRevision})
		if err != nil {
			return err
		}
		if isInvite { // ADR-0111: the server decides; the bot gets no callback, only BOT_DELEGATION (ADR-0119)
			edited, ev, err := delegationClick(ctx, q, m, inv, user, button.GetId())
			closed, event = &edited, ev
			return err
		}
		event = &v1.DispatchEvent{Event: &v1.DispatchEvent_BotCallback{BotCallback: &v1.BotCallback{
			Id: receipt.ID.String(), BotUserId: botID.String(), UserId: user.String(), WorkspaceId: rooms.WorkspaceIDString(acc), RoomId: m.RoomID.String(), MessageId: m.ID.String(), ButtonId: button.GetId(), Data: button.GetData(), KeyboardRevision: req.GetKeyboardRevision(), CreatedAt: timestamppb.New(receipt.CreatedAt),
		}}}
		// Atomically reuse the existing durable outbox. Publisher.User must NOT enqueue this
		// event again (bots.deliverable deliberately excludes BotCallback).
		if bot.WebhookUrl != nil && bot.WebhookDisabledAt == nil {
			payload, err := protojson.Marshal(&v1.BotWebhookUpdate{Id: receipt.ID.String(), BotUserId: botID.String(), CreatedAt: timestamppb.New(receipt.CreatedAt), Event: event})
			if err != nil {
				return err
			}
			return q.EnqueueWebhookDeliveries(ctx, sqlc.EnqueueWebhookDeliveriesParams{Ids: []uuid.UUID{receipt.ID}, BotIds: []uuid.UUID{botID}, Payloads: [][]byte{payload}})
		}
		return nil
	})
	if err != nil {
		return err
	}
	if event != nil {
		h.events.User(ctx, botID, event)
	} // post-commit gateway delivery is best effort
	if closed != nil {
		if err := (&System{h: h}).publishEdited(ctx, *closed); err != nil {
			slog.WarnContext(ctx, "delegation: publish closed invitation", "message_id", closed.ID, "err", err)
		}
	}
	httpx.Write(w, http.StatusOK, &v1.CreateMessageInteractionResponse{InteractionId: receipt.ID.String()})
	return nil
}
