//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/calls"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/push"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type delayedCallSender struct {
	*pushRecorder
	arrived chan push.Payload
	release chan struct{}
}

func (s *delayedCallSender) Send(ctx context.Context, endpoint push.Endpoint, payload push.Payload) push.Result {
	result := s.pushRecorder.Send(ctx, endpoint, payload)
	select {
	case s.arrived <- payload:
	default:
	}
	select {
	case <-s.release:
	case <-ctx.Done():
	}
	return result
}

func TestPushIncomingVoIPCurrentRingSessionAndExpiry(t *testing.T) {
	rec := &pushRecorder{}
	delayed := &delayedCallSender{pushRecorder: rec, arrived: make(chan push.Payload, 1), release: make(chan struct{})}
	t.Cleanup(func() {
		select {
		case <-delayed.release:
		default:
			close(delayed.release)
		}
	})
	a := app.New(app.Deps{Config: testCfg, DB: testDB, Redis: testRedis, Events: events.Nop{}, Blob: testStore, LiveKit: lkRec, Push: map[v1.PushProvider]push.Provider{
		v1.PushProvider_PUSH_PROVIDER_VOIP: {AppID: "ru.calab.test", Environment: "production", Sender: delayed},
	}})
	server := httptest.NewServer(a.Handler)
	t.Cleanup(server.Close)
	caller, callee, other, _ := callTeam(t)
	dm := openDM(t, caller.user, callee.id, 201).GetRoom().GetId()
	request := &v1.RegisterPushDeviceRequest{Provider: v1.PushProvider_PUSH_PROVIDER_VOIP, AppId: "ru.calab.test", Environment: "production", InstallationId: uuid.NewString(), Token: strings.Repeat("aa", 32), CallsEnabled: true, NotificationsEnabled: false, MentionsEnabled: proto.Bool(false), AllEnabled: false}
	var endpoint v1.RegisterPushDeviceResponse
	pushHTTP(t, server, callee.user, 200, "POST", "/api/me/push-devices", request, &endpoint)
	t.Cleanup(func() {
		_, _ = testDB.Pool.Exec(context.Background(), "DELETE FROM push_devices WHERE id=$1", endpoint.Id)
	})
	var duplicate v1.RegisterPushDeviceResponse
	pushHTTP(t, server, callee.user, 200, "POST", "/api/me/push-devices", request, &duplicate)
	if duplicate.Id != endpoint.Id || duplicate.Version != endpoint.Version {
		t.Fatal("idempotent VoIP endpoint rotated")
	}
	var capability v1.PushCapabilitiesResponse
	pushHTTP(t, server, callee.user, 200, "GET", "/api/me/push-capabilities", nil, &capability)
	if len(capability.Providers) != 1 || capability.Providers[0].Provider != v1.PushProvider_PUSH_PROVIDER_VOIP {
		t.Fatal("configured VoIP unavailable")
	}
	start := func() calls.Record {
		id := uuid.New()
		r := calls.Record{ID: id, DM: uuid.MustParse(dm), Caller: uuid.MustParse(caller.id), Callee: uuid.MustParse(callee.id), Created: time.Now().UnixMilli(), State: v1.CallState_CALL_STATE_RINGING}
		_, err := (calls.Store{C: testRedis}).Start(context.Background(), r, time.Now().Add(45*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		a.Push.Observe(context.Background(), uuid.MustParse(callee.id), &v1.DispatchEvent{Event: &v1.DispatchEvent_CallRing{CallRing: &v1.CallRing{Call: r.Proto()}}})
		return r
	}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE users SET display_name='Илья' WHERE id=$1", caller.id); err != nil {
		t.Fatal(err)
	}
	// Message previews must not change the caller's system-call presentation.
	callee.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{HideMessageTextInNotifications: proto.Bool(true)}, nil)
	if status, _, _ := upload(t, caller.user, "/api/me/avatar", "caller.png", pngBytes(64, 64)); status != 200 {
		t.Fatalf("caller avatar upload: %d", status)
	}
	ring := start()
	routePush(t, a.Push)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	delivered := make(chan error, 1)
	go func() { delivered <- a.Push.Deliver(ctx) }()
	var early push.Payload
	select {
	case early = <-delayed.arrived:
	case <-ctx.Done():
		t.Fatal("provider did not receive live call")
	}
	// A device can observe the payload before APNs returns and delivered_at commits.
	pushHTTP(t, server, callee.user, 404, "POST", "/api/me/push-resolve", &v1.ResolvePushRequest{Binding: early.Binding, EventId: early.EventID}, nil)
	close(delayed.release)
	if err := <-delivered; err != nil {
		t.Fatal(err)
	}
	if len(rec.sent()) != 1 {
		t.Fatal("message prefs suppressed a live incoming call")
	}
	receipt := rec.sent()[0]
	if receipt.CallerName != "Илья" || receipt.AvatarJPEG == "" || receipt.PersonID == "" {
		t.Fatal("message privacy changed authorized caller presentation")
	}
	encoded, _ := json.Marshal(receipt)
	for _, private := range []string{ring.ID.String(), dm, caller.id, callee.id, request.Token} {
		if strings.Contains(string(encoded), private) {
			t.Fatal("push exposed product/auth data")
		}
	}
	resolve := &v1.ResolvePushRequest{Binding: receipt.Binding, EventId: receipt.EventID}
	var response v1.ResolvePushResponse
	pushHTTP(t, server, callee.user, 200, "POST", "/api/me/push-resolve", resolve, &response)
	if response.Call == nil || response.Call.Id != ring.ID.String() || response.MessageId != "" {
		t.Fatal("ring resolve mismatch")
	}
	pushHTTP(t, server, other.user, 404, "POST", "/api/me/push-resolve", resolve, nil)
	second := secondDevice(t, callee.user)
	pushHTTP(t, server, second, 404, "POST", "/api/me/push-resolve", resolve, nil)
	callAction(t, callee.user, 200, ring.ID.String(), "accept")
	pushHTTP(t, server, callee.user, 200, "POST", "/api/me/push-resolve", resolve, &response)
	if response.Call.GetState() != v1.CallState_CALL_STATE_ACTIVE {
		t.Fatal("delivered receipt cannot reconcile an already accepted call")
	}
	pushHTTP(t, server, second, 404, "POST", "/api/me/push-resolve", resolve, nil)
	callAction(t, callee.user, 200, ring.ID.String(), "hangup")
	pushHTTP(t, server, callee.user, 404, "POST", "/api/me/push-resolve", resolve, nil)
	suppressed := start()
	routePush(t, a.Push)
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE users SET presence_status=$2 WHERE id=$1", callee.id, int32(v1.PresenceStatus_PRESENCE_STATUS_DND)); err != nil {
		t.Fatal(err)
	}
	deliverPush(t, a.Push)
	if len(rec.sent()) != 1 {
		t.Fatal("DND rang")
	}
	callAction(t, caller.user, 200, suppressed.ID.String(), "cancel")
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE users SET presence_status=NULL WHERE id=$1", callee.id); err != nil {
		t.Fatal(err)
	}
	answered := start()
	routePush(t, a.Push)
	callAction(t, callee.user, 200, answered.ID.String(), "accept")
	deliverPush(t, a.Push)
	if len(rec.sent()) != 1 {
		t.Fatal("answered elsewhere rang")
	}
	callAction(t, callee.user, 200, answered.ID.String(), "hangup")
	expired := start()
	routePush(t, a.Push)
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE push_deliveries SET expires_at=now()-interval '1 second' WHERE device_id=$1 AND delivered_at IS NULL", endpoint.Id); err != nil {
		t.Fatal(err)
	}
	deliverPush(t, a.Push)
	if len(rec.sent()) != 1 {
		t.Fatal("expired event rang")
	}
	callAction(t, caller.user, 200, expired.ID.String(), "cancel")
}

// Android carries messages and calls on one FCM token: message preferences off must
// still ring, and the ring resolves through the same current-session receipt.
func TestPushIncomingCallOverFCMEndpoint(t *testing.T) {
	rec := &pushRecorder{}
	a := app.New(app.Deps{Config: testCfg, DB: testDB, Redis: testRedis, Events: events.Nop{}, Blob: testStore, LiveKit: lkRec, Push: map[v1.PushProvider]push.Provider{
		v1.PushProvider_PUSH_PROVIDER_FCM: {AppID: "ru.calab.test", Environment: "production", Sender: rec},
	}})
	server := httptest.NewServer(a.Handler)
	t.Cleanup(server.Close)
	caller, callee, _, _ := callTeam(t)
	dm := openDM(t, caller.user, callee.id, 201).GetRoom().GetId()
	request := &v1.RegisterPushDeviceRequest{Provider: v1.PushProvider_PUSH_PROVIDER_FCM, AppId: "ru.calab.test", Environment: "production", InstallationId: uuid.NewString(), Token: "fcm:" + strings.Repeat("A1_-", 30), CallsEnabled: true, NotificationsEnabled: false, MentionsEnabled: proto.Bool(false), AllEnabled: false}
	var endpoint v1.RegisterPushDeviceResponse
	pushHTTP(t, server, callee.user, 200, "POST", "/api/me/push-devices", request, &endpoint)
	t.Cleanup(func() {
		_, _ = testDB.Pool.Exec(context.Background(), "DELETE FROM push_devices WHERE id=$1", endpoint.Id)
	})
	r := calls.Record{ID: uuid.New(), DM: uuid.MustParse(dm), Caller: uuid.MustParse(caller.id), Callee: uuid.MustParse(callee.id), Created: time.Now().UnixMilli(), State: v1.CallState_CALL_STATE_RINGING}
	if _, err := (calls.Store{C: testRedis}).Start(context.Background(), r, time.Now().Add(45*time.Second)); err != nil {
		t.Fatal(err)
	}
	a.Push.Observe(context.Background(), uuid.MustParse(callee.id), &v1.DispatchEvent{Event: &v1.DispatchEvent_CallRing{CallRing: &v1.CallRing{Call: r.Proto()}}})
	deliverPush(t, a.Push)
	sent := rec.sent()
	if len(sent) != 1 || sent[0].Kind != "call" || sent[0].Binding != endpoint.Id {
		t.Fatal("FCM call endpoint did not ring", len(sent))
	}
	var response v1.ResolvePushResponse
	pushHTTP(t, server, callee.user, 200, "POST", "/api/me/push-resolve", &v1.ResolvePushRequest{Binding: sent[0].Binding, EventId: sent[0].EventID}, &response)
	if response.Call == nil || response.Call.Id != r.ID.String() || response.RoomId != dm {
		t.Fatal("FCM ring resolve mismatch")
	}
	// The caller hangs up before an answer: the phone gets an opaque cancel for that ring. The
	// shared test server publishes through its own push service, so this app observes the
	// state change directly, as it observed the ring; the caller has no ring to cancel.
	ended := callAction(t, caller.user, 200, r.ID.String(), "cancel")
	if ended.GetState() != v1.CallState_CALL_STATE_CANCELLED {
		t.Fatal("call not cancelled", ended.GetState())
	}
	state := &v1.DispatchEvent{Event: &v1.DispatchEvent_CallState{CallState: &v1.CallStateUpdate{Call: ended}}}
	a.Push.Observe(context.Background(), uuid.MustParse(caller.id), state)
	a.Push.Observe(context.Background(), uuid.MustParse(callee.id), state)
	deadline := time.Now().Add(5 * time.Second)
	for {
		all := rec.sent()
		if last := all[len(all)-1]; last.Kind == "call-cancel" {
			if len(all) != 2 || last.EventID != sent[0].EventID || last.Binding != sent[0].Binding || last.CallerName != "" {
				t.Fatal("ring cancel must name only the delivered ring")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("ended ring was not cancelled on the FCM endpoint")
		}
		time.Sleep(20 * time.Millisecond)
	}
	encoded, _ := json.Marshal(rec.sent()[1])
	if strings.Contains(string(encoded), r.ID.String()) || strings.Contains(string(encoded), dm) {
		t.Fatal("ring cancel exposed the call or room")
	}
	// Past the ring's own expiry there is nothing left to cancel.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE push_deliveries SET expires_at=now()-interval '1 second' WHERE device_id=$1", endpoint.Id); err != nil {
		t.Fatal(err)
	}
	a.Push.Observe(context.Background(), uuid.MustParse(callee.id), state)
	time.Sleep(300 * time.Millisecond)
	if len(rec.sent()) != 2 {
		t.Fatal("an expired ring was cancelled again")
	}
}
