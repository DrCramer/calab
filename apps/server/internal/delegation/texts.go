package delegation

import (
	"strings"
	"unicode"
	"unicode/utf8"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/mail"
)

// The bot's DM suggesting a consent is written in the invitee's language (users.locale, English
// otherwise): the server composes it, the bot cannot change it without voiding the buttons.

type texts struct {
	invite, inviteByBot, reason, accept, decline, accepted, declined, cancelled string
}

var byLocale = map[string]texts{
	mail.LocaleRU: {
		invite: "{inviter} предлагает разрешить боту {bot} действовать от вашего имени в пространстве «{ws}»: " +
			"создавать и править задачи, комментарии, вложения, наблюдателей. Всё будет помечено «через бота {bot}». " +
			"Отозвать разрешение можно в любой момент: меню «⋯» бота → «Делегировать права».",
		inviteByBot: "Бот {bot} просит разрешить ему действовать от вашего имени в пространстве «{ws}»: " +
			"создавать и править задачи, комментарии, вложения, наблюдателей. Всё будет помечено «через бота {bot}». " +
			"Разрешение даёте только вы; отозвать его можно в любой момент: меню «⋯» бота → «Делегировать права».",
		reason: "Зачем, со слов бота: {reason}",
		accept: "Принять", decline: "Отказаться",
		accepted: "✓ Вы разрешили.", declined: "✗ Вы отказались.", cancelled: "Предложение отменено.",
	},
	mail.LocaleEN: {
		invite: "{inviter} suggests letting the bot {bot} act on your behalf in the workspace “{ws}”: " +
			"create and edit tasks, comments, attachments, watchers. Everything will be marked “via bot {bot}”. " +
			"You can revoke it at any time: the bot's “⋯” menu → “Delegate rights”.",
		inviteByBot: "The bot {bot} asks you to let it act on your behalf in the workspace “{ws}”: " +
			"create and edit tasks, comments, attachments, watchers. Everything will be marked “via bot {bot}”. " +
			"Only you can allow it, and you can revoke it at any time: the bot's “⋯” menu → “Delegate rights”.",
		reason: "Why, in the bot's words: {reason}",
		accept: "Accept", decline: "Decline",
		accepted: "✓ You allowed it.", declined: "✗ You declined.", cancelled: "The suggestion was cancelled.",
	},
	mail.LocaleES: {
		invite: "{inviter} propone permitir que el bot {bot} actúe en tu nombre en el espacio «{ws}»: " +
			"crear y editar tareas, comentarios, adjuntos, observadores. Todo quedará marcado «a través del bot {bot}». " +
			"Puedes revocarlo en cualquier momento: menú «⋯» del bot → «Delegar permisos».",
		inviteByBot: "El bot {bot} te pide permiso para actuar en tu nombre en el espacio «{ws}»: " +
			"crear y editar tareas, comentarios, adjuntos, observadores. Todo quedará marcado «a través del bot {bot}». " +
			"Solo tú puedes permitirlo y puedes revocarlo en cualquier momento: menú «⋯» del bot → «Delegar permisos».",
		reason: "Para qué, según el bot: {reason}",
		accept: "Aceptar", decline: "Rechazar",
		accepted: "✓ Lo has permitido.", declined: "✗ Lo has rechazado.", cancelled: "La propuesta se ha cancelado.",
	},
	mail.LocaleZhCN: {
		invite: "{inviter} 建议允许机器人 {bot} 在工作区「{ws}」中代表你操作：创建和编辑任务、评论、附件、关注者。" +
			"所有操作都会标注“通过机器人 {bot}”。你可以随时撤销：机器人的“⋯”菜单 → “委托权限”。",
		inviteByBot: "机器人 {bot} 请求你允许它在工作区「{ws}」中代表你操作：创建和编辑任务、评论、附件、关注者。" +
			"所有操作都会标注“通过机器人 {bot}”。只有你本人可以允许，并可随时撤销：机器人的“⋯”菜单 → “委托权限”。",
		reason: "用途（机器人所述）：{reason}",
		accept: "接受", decline: "拒绝",
		accepted: "✓ 你已允许。", declined: "✗ 你已拒绝。", cancelled: "该建议已取消。",
	},
}

func textsFor(locale *string) texts {
	l := mail.LocaleEN
	if locale != nil {
		l = mail.Locale(*locale)
	}
	if t, ok := byLocale[l]; ok {
		return t
	}
	return byLocale[mail.LocaleEN]
}

// Invite is the bot's DM to the invitee: the text naming the inviter, the bot and the workspace,
// and the keyboard «Принять» / «Отказаться» for the invitee only. byBot: the bot asks for itself
// (ADR-0119), the text names only the bot; inviter is then ignored. reason (already
// CleanReason) is added as the inviter's words when not empty.
func Invite(locale *string, inviter, bot, ws string, invitee string, byBot bool, reason string) (string, *v1.InlineKeyboard) {
	t := textsFor(locale)
	tpl := t.invite
	if byBot {
		tpl = t.inviteByBot
	}
	// The bot names itself (PATCH /api/me): inside the server's text its name gets the reason's
	// filter, so no mention, link, markup or line break in it poses as the server's words.
	text := strings.NewReplacer("{inviter}", inviter, "{bot}", plainLine(bot), "{ws}", ws).Replace(tpl)
	if reason != "" {
		text += "\n\n" + strings.Replace(t.reason, "{reason}", reason, 1)
	}
	return text, &v1.InlineKeyboard{
		Rows: []*v1.InlineKeyboardRow{{Buttons: []*v1.InlineButton{
			{Id: ButtonAccept, Label: t.accept},
			{Id: ButtonDecline, Label: t.decline},
		}}},
		AllowedUserIds: []string{invitee},
	}
}

// MaxReason bounds InviteBotDelegationRequest.reason, in characters.
const MaxReason = 200

// reasonPunct: the punctuation a reason keeps. Everything that could make the inviter's words
// look like more than plain text inside the server's message is dropped: "@" (a mention renders
// as a person's name), "/" (links), markup characters (*_~`[]<>#|\).
const reasonPunct = ".,!?-–—:;«»\"'()%№+"

// CleanReason is the inviter's reason as the DM shows it: one line of letters, digits, spaces
// and plain punctuation (reasonPunct), trimmed. ok=false: longer than MaxReason characters.
func CleanReason(raw string) (string, bool) {
	if utf8.RuneCountInString(raw) > MaxReason {
		return "", false
	}
	return plainLine(raw), true
}

// plainLine keeps of raw one line of letters, digits, marks, single spaces and reasonPunct.
func plainLine(raw string) string {
	var b strings.Builder
	space := false
	for _, r := range raw {
		switch {
		case unicode.IsSpace(r):
			space = true
			continue
		case unicode.IsLetter(r), unicode.IsDigit(r), unicode.IsMark(r), strings.ContainsRune(reasonPunct, r):
		default:
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

// Outcome is the line appended to the invitation when it closes: accepted, declined (by the
// invitee) or cancelled (by the inviter).
type Outcome int

// Outcomes of an invitation.
const (
	Accepted Outcome = iota + 1
	Declined
	Cancelled
)

// OutcomeText is the closing line in the invitee's language.
func OutcomeText(locale *string, o Outcome) string {
	t := textsFor(locale)
	switch o {
	case Accepted:
		return t.accepted
	case Declined:
		return t.declined
	}
	return t.cancelled
}
