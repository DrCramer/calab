package delegation

import (
	"strings"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/mail"
)

// The bot's DM suggesting a consent is written in the invitee's language (users.locale, English
// otherwise): the server composes it, the bot cannot change it without voiding the buttons.

type texts struct {
	invite, accept, decline, accepted, declined, cancelled string
}

var byLocale = map[string]texts{
	mail.LocaleRU: {
		invite: "{inviter} предлагает разрешить боту {bot} действовать от вашего имени в пространстве «{ws}»: " +
			"создавать и править задачи, комментарии, вложения, наблюдателей. Всё будет помечено «через бота {bot}». " +
			"Отозвать разрешение можно в любой момент: меню «⋯» бота → «Делегировать права».",
		accept: "Принять", decline: "Отказаться",
		accepted: "✓ Вы разрешили.", declined: "✗ Вы отказались.", cancelled: "Предложение отменено.",
	},
	mail.LocaleEN: {
		invite: "{inviter} suggests letting the bot {bot} act on your behalf in the workspace “{ws}”: " +
			"create and edit tasks, comments, attachments, watchers. Everything will be marked “via bot {bot}”. " +
			"You can revoke it at any time: the bot's “⋯” menu → “Delegate rights”.",
		accept: "Accept", decline: "Decline",
		accepted: "✓ You allowed it.", declined: "✗ You declined.", cancelled: "The suggestion was cancelled.",
	},
	mail.LocaleES: {
		invite: "{inviter} propone permitir que el bot {bot} actúe en tu nombre en el espacio «{ws}»: " +
			"crear y editar tareas, comentarios, adjuntos, observadores. Todo quedará marcado «a través del bot {bot}». " +
			"Puedes revocarlo en cualquier momento: menú «⋯» del bot → «Delegar permisos».",
		accept: "Aceptar", decline: "Rechazar",
		accepted: "✓ Lo has permitido.", declined: "✗ Lo has rechazado.", cancelled: "La propuesta se ha cancelado.",
	},
	mail.LocaleZhCN: {
		invite: "{inviter} 建议允许机器人 {bot} 在工作区「{ws}」中代表你操作：创建和编辑任务、评论、附件、关注者。" +
			"所有操作都会标注“通过机器人 {bot}”。你可以随时撤销：机器人的“⋯”菜单 → “委托权限”。",
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
// and the keyboard «Принять» / «Отказаться» for the invitee only.
func Invite(locale *string, inviter, bot, ws string, invitee string) (string, *v1.InlineKeyboard) {
	t := textsFor(locale)
	text := strings.NewReplacer("{inviter}", inviter, "{bot}", bot, "{ws}", ws).Replace(t.invite)
	return text, &v1.InlineKeyboard{
		Rows: []*v1.InlineKeyboardRow{{Buttons: []*v1.InlineButton{
			{Id: ButtonAccept, Label: t.accept},
			{Id: ButtonDecline, Label: t.decline},
		}}},
		AllowedUserIds: []string{invitee},
	}
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
