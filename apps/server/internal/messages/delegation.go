package messages

import (
	"context"
	"log/slog"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/delegation"
	"github.com/calaba/calaba/server/internal/dms"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

// A member lets a bot act on their behalf (ADR-0111): the server writes the bot's DM that
// suggests it, and handles the invitee's click on its buttons itself (never a BOT_CALLBACK: the
// bot neither sees nor decides the consent).

// SendBotDM writes a server-composed message of bot with keyboard k into its DM with person
// (opened when missing) and publishes it like the bot's own message. inTx runs in the same
// transaction with the inserted message. A person who blocked the bot, or with whom it shares
// no workspace, is refused (dms.CheckBotDM).
func (s *System) SendBotDM(ctx context.Context, bot, person uuid.UUID, content string, k *v1.InlineKeyboard, inTx func(q *sqlc.Queries, m sqlc.Message) error) (sqlc.Message, error) {
	keyboard, err := encodeKeyboard(k)
	if err != nil {
		return sqlc.Message{}, err
	}
	key := dms.Key(bot, person)
	var (
		msg     sqlc.Message
		roomID  uuid.UUID
		created bool
	)
	err = s.h.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := dms.CheckBotDM(ctx, q, bot, person); err != nil {
			return err
		}
		room, err := q.GetDMByKey(ctx, &key)
		if db.IsNotFound(err) {
			room, err = q.CreateDMRoom(ctx, &key)
			if db.IsNotFound(err) { // a concurrent request created it
				room, err = q.GetDMByKey(ctx, &key)
			} else if err == nil {
				created = true
				err = q.AddDMMembers(ctx, sqlc.AddDMMembersParams{RoomID: room.ID, UserIds: []uuid.UUID{bot, person}})
			}
		}
		if err != nil {
			return err
		}
		roomID = room.ID
		if msg, err = q.InsertMessage(ctx, sqlc.InsertMessageParams{RoomID: roomID, AuthorID: bot, Content: content, InlineKeyboard: keyboard}); err != nil {
			return err
		}
		if _, err := q.UpsertReadState(ctx, sqlc.UpsertReadStateParams{UserID: bot, RoomID: roomID, LastReadMessageID: msg.ID}); err != nil {
			return err
		}
		return inTx(q, msg)
	})
	if err != nil {
		return msg, err
	}
	members := []uuid.UUID{bot, person}
	if created {
		for _, u := range members {
			if sum, err := dms.One(ctx, s.h.db.Q, u, roomID); err == nil {
				s.h.events.User(ctx, u, &v1.DispatchEvent{Event: &v1.DispatchEvent_DmCreate{DmCreate: &v1.DmCreate{Dm: sum}}})
			}
		}
	}
	if states, err := db.GuardValue(ctx, s.h.db, func(guarded *sqlc.Queries) ([]sqlc.DmState, error) {
		return guarded.UnarchiveDMForRecipients(ctx, sqlc.UnarchiveDMForRecipientsParams{RoomID: roomID, AuthorID: bot})
	}); err == nil {
		for _, st := range states {
			s.h.events.User(ctx, st.UserID, dms.StateEvent(st))
		}
	}
	rooms.Publish(ctx, s.h.events, perm.RoomAccess{DM: true, Members: members}, &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{
		MessageCreate: &v1.MessageCreate{Message: pbconv.Message(msg, nil)},
	}})
	return msg, nil
}

// CloseBotPrompt ends a server-composed bot message: removes its keyboard and appends line to
// its text, then publishes MESSAGE_UPDATE. A deleted message is left alone.
func (s *System) CloseBotPrompt(ctx context.Context, messageID uuid.UUID, line string) error {
	var edited sqlc.Message
	err := s.h.db.Tx(ctx, func(q *sqlc.Queries) error {
		m, err := q.GetMessageForInteraction(ctx, messageID)
		if err != nil {
			return err
		}
		edited, err = closePrompt(ctx, q, m, line)
		return err
	})
	if db.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.publishEdited(ctx, edited)
}

// closePrompt is CloseBotPrompt inside the caller's transaction (m locked).
func closePrompt(ctx context.Context, q *sqlc.Queries, m sqlc.Message, line string) (sqlc.Message, error) {
	content := m.Content + "\n\n" + line
	if utf8.RuneCountInString(content) > MaxContent {
		content = line
	}
	return q.UpdateMessageContent(ctx, sqlc.UpdateMessageContentParams{ID: m.ID, Content: &content, SetKeyboard: true})
}

// publishEdited publishes MESSAGE_UPDATE of m to its room's audience.
func (s *System) publishEdited(ctx context.Context, m sqlc.Message) error {
	aud, err := s.h.db.Q.RoomAudience(ctx, m.RoomID)
	if db.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	acc := perm.RoomAccess{DM: aud.Dm, Members: aud.DmMembers}
	if aud.WorkspaceID != nil {
		acc.WorkspaceID = *aud.WorkspaceID
	}
	return s.publishUpdate(ctx, acc, m)
}

// delegationClick handles a click on the buttons of a consent invitation (m carries inv): only
// the invitee's own click counts (the identity of the request, never the request body), on the
// message exactly as the server wrote it (any edit by the bot changes keyboard_revision and voids
// it). «Принять» records the consent (delegation.Grant re-checks who may give it), «Отказаться»
// drops the invitation (and remembers the decline); either closes the message. ev is
// BOT_DELEGATION for the bot's user channel (its webhook delivery is queued in q's transaction),
// nil when nothing changed for the bot.
func delegationClick(ctx context.Context, q *sqlc.Queries, m sqlc.Message, inv sqlc.BotDelegationInvite, user uuid.UUID, button string) (sqlc.Message, *v1.DispatchEvent, error) {
	if inv.UserID != user {
		return sqlc.Message{}, nil, httpx.Forbidden("this keyboard belongs to another user")
	}
	if inv.KeyboardRevision != m.KeyboardRevision || inv.BotID != m.AuthorID {
		return sqlc.Message{}, nil, httpx.Conflict("the invitation changed; it is no longer valid").WithDetails("KEYBOARD_STALE", 0, 0)
	}
	u, err := q.GetUser(ctx, user)
	if err != nil {
		return sqlc.Message{}, nil, err
	}
	outcome := delegation.Declined
	var ev *v1.DispatchEvent
	switch button {
	case delegation.ButtonAccept:
		if _, ev, err = delegation.Grant(ctx, q, inv.WorkspaceID, inv.BotID, user); err != nil {
			return sqlc.Message{}, nil, err
		}
		outcome = delegation.Accepted
		// The same audit line as PUT …/delegations/{userId} (bots.grant), marked as the click.
		slog.InfoContext(ctx, "bot delegation", "workspace_id", inv.WorkspaceID, "bot_id", inv.BotID, "member_id", user, "on", true, "via", "invite", "invited_by", inv.InvitedBy)
	case delegation.ButtonDecline:
		if _, ev, err = delegation.Decline(ctx, q, inv.WorkspaceID, inv.BotID, user); err != nil {
			return sqlc.Message{}, nil, err
		}
		slog.InfoContext(ctx, "bot delegation invite declined", "workspace_id", inv.WorkspaceID, "bot_id", inv.BotID, "member_id", user, "invited_by", inv.InvitedBy)
	default:
		return sqlc.Message{}, nil, httpx.Conflict("button is unavailable").WithDetails("BUTTON_UNAVAILABLE", 0, 0)
	}
	edited, err := closePrompt(ctx, q, m, delegation.OutcomeText(u.Locale, outcome))
	return edited, ev, err
}

// delegationInvite returns the consent invitation m carries (ok=false: a bot's own message).
func delegationInvite(ctx context.Context, q *sqlc.Queries, m sqlc.Message) (sqlc.BotDelegationInvite, bool, error) {
	inv, err := q.GetBotDelegationInviteByMessage(ctx, &m.ID)
	if err == nil {
		return inv, true, nil
	}
	if db.IsNotFound(err) {
		return inv, false, nil
	}
	return inv, false, err
}
