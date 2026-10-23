package sip

import (
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/pbconv"
)

func TestMaskNumber(t *testing.T) {
	for in, want := range map[string]string{
		"+79161234567": "+7916*****67",
		"+12025550147": "+1202*****47",
		"88001234":     "8800**34",
		"10234":        "1**34",
		"1234":         "****",
		"anonymous":    "*********",
		"":             "",
	} {
		if got := maskNumber(in); got != want {
			t.Errorf("maskNumber(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestActiveCallStep(t *testing.T) {
	menu, group, user, bob := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	ex := &exchange{menu: map[uuid.UUID]sqlc.SipIvrMenu{menu: {ID: menu, Name: "Главное меню"}}, group: map[uuid.UUID]sqlc.SipGroup{group: {ID: group, Name: "Продажи"}}}
	in := sqlc.SipCall{ID: uuid.New(), Direction: "in", Status: pbconv.SipRinging, Number: "+79161234567"}
	out := sqlc.SipCall{ID: uuid.New(), Direction: "out", Status: pbconv.SipDialing, Number: "+79161234567"}

	if a := activeCall(out, nil, nil); a.Step != v1.SipActiveStep_SIP_ACTIVE_STEP_DIALING {
		t.Fatalf("outbound dialing: %v", a.Step)
	}
	out.Status = pbconv.SipActive
	if a := activeCall(out, nil, nil); a.Step != v1.SipActiveStep_SIP_ACTIVE_STEP_CONNECTED {
		t.Fatalf("outbound answered: %v", a.Step)
	}

	a := activeCall(in, &inRec{InCall: InCall{Phase: PhaseMenu, Menu: &menu}}, ex)
	if a.Step != v1.SipActiveStep_SIP_ACTIVE_STEP_MENU || a.StepId != menu.String() || a.StepName != "Главное меню" {
		t.Fatalf("menu: %v %q %q", a.Step, a.StepId, a.StepName)
	}
	a = activeCall(in, &inRec{InCall: InCall{Phase: PhaseRing, Group: &group, Ringing: []uuid.UUID{user, bob}}}, ex)
	if a.Step != v1.SipActiveStep_SIP_ACTIVE_STEP_RINGING || a.StepName != "Продажи" || len(a.Call.RingingUserIds) != 2 {
		t.Fatalf("ring group: %v %q %v", a.Step, a.StepName, a.Call.RingingUserIds)
	}
	a = activeCall(in, &inRec{InCall: InCall{Phase: PhaseRing, Ringing: []uuid.UUID{user}}}, ex)
	if a.StepId != "" || a.StepName != "" || len(a.Call.RingingUserIds) != 1 {
		t.Fatalf("ring one number: %q %q", a.StepId, a.StepName)
	}
	a = activeCall(in, &inRec{InCall: InCall{Phase: PhaseActive, Answered: &bob}}, ex)
	if a.Step != v1.SipActiveStep_SIP_ACTIVE_STEP_CONNECTED || a.Call.AnsweredBy != bob.String() {
		t.Fatalf("answered: %v %q", a.Step, a.Call.AnsweredBy)
	}
	// A menu deleted while the call is in it: the step stays, without a name.
	gone := uuid.New()
	if a = activeCall(in, &inRec{InCall: InCall{Phase: PhaseMenu, Menu: &gone}}, ex); a.StepName != "" || a.StepId != gone.String() {
		t.Fatalf("deleted menu: %q", a.StepName)
	}
}
