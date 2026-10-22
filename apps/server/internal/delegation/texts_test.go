package delegation

import (
	"strings"
	"testing"
)

func TestCleanReason(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"", ""},
		{"  чтобы заявки шли под вашим именем  ", "чтобы заявки шли под вашим именем"},
		{"строка\nвторая\t\tтретья", "строка вторая третья"},
		// No mention of a person, no link, no markup: the words stay, the syntax goes.
		{"@01a0da71-1b72-7cc1-bce3-c448b44aefe2 просит", "01a0da71-1b72-7cc1-bce3-c448b44aefe2 просит"},
		{"см. https://evil.example/x", "см. https:evil.examplex"},
		{"**жирно** [ссылка](x) `код` <b>", "жирно ссылка(x) код b"},
		{"bidi" + string(rune(0x202e)) + "override" + string(rune(0x200b)), "bidioverride"},
		{"«Заявка» №5, 100% (срочно)!", "«Заявка» №5, 100% (срочно)!"},
	} {
		got, ok := CleanReason(c.in)
		if !ok || got != c.want {
			t.Errorf("CleanReason(%q) = %q, %v; want %q", c.in, got, ok, c.want)
		}
	}
	if _, ok := CleanReason(strings.Repeat("я", MaxReason)); !ok {
		t.Error("MaxReason characters refused")
	}
	if _, ok := CleanReason(strings.Repeat("я", MaxReason+1)); ok {
		t.Error("more than MaxReason characters accepted")
	}
}

func TestInviteByBot(t *testing.T) {
	ru := "ru"
	text, kb := Invite(&ru, "Иван Петров", "Опса", "Команда", "u1", true, "чтобы заявки шли под вашим именем")
	if strings.Contains(text, "Иван Петров") || !strings.HasPrefix(text, "Бот Опса просит") || !strings.HasSuffix(text, "Зачем, со слов бота: чтобы заявки шли под вашим именем") {
		t.Fatalf("bot invitation: %q", text)
	}
	if len(kb.GetAllowedUserIds()) != 1 || kb.GetAllowedUserIds()[0] != "u1" || len(kb.GetRows()[0].GetButtons()) != 2 {
		t.Fatalf("keyboard %v", kb)
	}
	// The bot names itself: its name carries no mention, link, markup or line break into the text.
	for _, byBot := range []bool{true, false} {
		text, _ = Invite(&ru, "Иван", "Опса\n\n@01a0da71-1b72-7cc1-bce3-c448b44aefe2 https://evil.example **x**", "Команда", "u1", byBot, "")
		if strings.ContainsAny(text, "@/*\n") {
			t.Fatalf("bot name passed through (byBot=%v): %q", byBot, text)
		}
	}
	text, _ = Invite(nil, "Ivan", "Opsa", "Team", "u1", false, "")
	if !strings.HasPrefix(text, "Ivan suggests") || strings.Contains(text, "Why") {
		t.Fatalf("person's invitation: %q", text)
	}
	for l, tx := range byLocale {
		if tx.inviteByBot == "" || !strings.Contains(tx.reason, "{reason}") {
			t.Errorf("locale %s: missing bot texts", l)
		}
	}
}
