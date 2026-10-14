package messages

import (
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

func TestComposeContactOnlyRequestedAndSet(t *testing.T) {
	phone, email, now := "+79990001122", "a@b.test", time.Now()
	u := sqlc.User{ID: uuid.New(), DisplayName: "Olga", Phone: &phone, Email: &email, EmailVerifiedAt: &now}
	phoneOnly, fields := composeContact(u, []v1.ContactField{v1.ContactField_CONTACT_FIELD_PHONE})
	if phoneOnly.GetEmail() != "" || phoneOnly.GetEmailVerified() || phoneOnly.GetPhone() != phone || phoneOnly.GetPhoneVerified() || len(fields) != 1 {
		t.Fatalf("phone only: %v", phoneOnly)
	}
	both, fields := composeContact(u, []v1.ContactField{v1.ContactField_CONTACT_FIELD_EMAIL, v1.ContactField_CONTACT_FIELD_PHONE})
	if both.GetEmail() != email || !both.GetEmailVerified() || len(fields) != 2 || fields[0] != v1.ContactField_CONTACT_FIELD_PHONE {
		t.Fatalf("both: %v", both)
	}
	u.Phone, u.EmailVerifiedAt = nil, nil
	none, fields := composeContact(u, []v1.ContactField{v1.ContactField_CONTACT_FIELD_PHONE})
	if len(fields) != 0 || none.GetPhone() != "" {
		t.Fatalf("unset phone: %v", none)
	}
	if c, _ := composeContact(u, []v1.ContactField{v1.ContactField_CONTACT_FIELD_EMAIL}); c.GetEmailVerified() {
		t.Fatal("unverified email reported as verified")
	}
}

func TestContactDMOnly(t *testing.T) {
	k := &v1.InlineKeyboard{Rows: []*v1.InlineKeyboardRow{{Buttons: []*v1.InlineButton{{Id: "c", Label: "C", Kind: v1.InlineButtonKind_INLINE_BUTTON_KIND_REQUEST_CONTACT, Fields: []v1.ContactField{v1.ContactField_CONTACT_FIELD_PHONE}}}}}}
	if _, err := encodeKeyboard(k); err != nil {
		t.Fatal(err)
	}
	if contactDMOnly(k, perm.RoomAccess{}) == nil || contactDMOnly(k, perm.RoomAccess{DM: true}) != nil || contactDMOnly(nil, perm.RoomAccess{}) != nil {
		t.Fatal("DM-only rule")
	}
}
