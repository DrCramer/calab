package recording

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/disk"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/voice"
)

// Phone call recording to the workspace Disk (ADR-0131, CBF-81). The telephony calls
// CallConnected when a call reaches a person or a bot (inbound: answered, not while the menu
// plays; outbound: the callee picked up) and CallEnded when it ends. A recorded call gets a row
// in sip_call_recordings and an audio-only room composite egress of its LiveKit room into an
// Ogg/Opus file — on the recordings volume or in the files bucket, like a meeting (storage.go).
// When the egress ends (the room closed, the stop) the file becomes a Disk file
// /phone_recordings/YYYY_MM_DD/YYYYMMDDHHMM_<digits>_<IN|OUT>.ogg owned by the workspace
// owner and counted in its storage. Nothing here may break a call: every failure is a log line
// and a metric, the call goes on unrecorded.

// PhoneRoot is the Disk folder of the phone recordings; created for the owner alone.
const PhoneRoot = "phone_recordings"

// Errors of sip_call_recordings.error.
const (
	phoneErrEgress   = "egress"       // the egress did not start
	phoneErrLost     = "lost"         // the start never reached the egress
	phoneErrNoAudio  = "no_audio"     // the egress ended without a file
	phoneErrQuota    = "quota"        // the workspace (or server) storage is full
	phoneErrBlocked  = "path_blocked" // a file holds the name of a folder of the path
	phoneErrStorage  = "storage"      // the file storage did not answer for StorageWait
	phoneErrDisabled = "suspended"    // the workspace is suspended: its Disk takes nothing
)

var metricPhone = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "calaba_sip_recordings_total",
	Help: "Phone call recordings (ADR-0131) by result: started, stored, skipped_limit, failed_<reason>.",
}, []string{"result"})

// DiskPlacer files a stored file into the Disk (disk.Service.PlaceFile).
type DiskPlacer interface {
	PlaceFile(ctx context.Context, ws, owner uuid.UUID, path []disk.Folder, f sqlc.File, name string) (sqlc.DiskItem, error)
}

// PhoneConfig configures phone call recording (SetPhone).
type PhoneConfig struct {
	// Location names the day folders and the files (SIP_RECORDING_TZ; nil = UTC). Workspaces
	// have no time zone of their own.
	Location *time.Location
	// MaxConcurrent: phone recordings at once on this server (SIP_RECORDING_MAX_CONCURRENT);
	// a call over it goes unrecorded (log + metric).
	MaxConcurrent int
	Disk          DiskPlacer
	// MaxCall: the longest call (sip.MaxCallTime); an egress running past it is stopped.
	MaxCall time.Duration
}

// SetPhone turns phone call recording on (the files service must be set too: SetFiles).
func (s *Service) SetPhone(cfg PhoneConfig) {
	if cfg.Location == nil {
		cfg.Location = time.UTC
	}
	if cfg.MaxConcurrent < 1 {
		cfg.MaxConcurrent = 10
	}
	if cfg.MaxCall <= 0 {
		cfg.MaxCall = 2 * time.Hour
	}
	s.phone = &cfg
}

// PhoneAvailable reports that calls can be recorded (LiveKit Egress and the Disk are set up).
func (s *Service) PhoneAvailable() bool { return s.phone != nil && s.eg != nil && s.files != nil }

// phoneFile is the raw file of a phone recording on the volume / blob key in the bucket.
func phoneFile(ws, id uuid.UUID) string { return "phone/" + ws.String() + "/" + id.String() + ".ogg" }

// PhoneName is where a recording of a call started at t goes: the day folder (YYYY_MM_DD) and
// the file name YYYYMMDDHHMM_<digits of number>_<IN|OUT>.ogg, both in loc. A number without
// digits (an anonymous caller) is «unknown».
func PhoneName(t time.Time, loc *time.Location, number string, inbound bool) (day, name string) {
	if loc == nil {
		loc = time.UTC
	}
	t = t.In(loc)
	var b strings.Builder
	for _, r := range number {
		if r >= '0' && r <= '9' && b.Len() < 32 {
			b.WriteRune(r)
		}
	}
	digits := b.String()
	if digits == "" {
		digits = "unknown"
	}
	dir := "OUT"
	if inbound {
		dir = "IN"
	}
	return t.Format("2006_01_02"), t.Format("200601021504") + "_" + digits + "_" + dir + ".ogg"
}

// CallConnected starts recording call id when its workspace records calls of its direction.
// It returns at once: the egress may take seconds to start and the call must not wait.
func (s *Service) CallConnected(ctx context.Context, id uuid.UUID) {
	if !s.PhoneAvailable() {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
		defer cancel()
		s.startPhone(ctx, id)
	}()
}

// CallEnded stops the recording of call id (an outbound call's voice room lives on; an inbound
// call's room is closed anyway, the stop only makes it sooner). It returns at once.
func (s *Service) CallEnded(ctx context.Context, id uuid.UUID) {
	if !s.PhoneAvailable() {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		rec, err := s.db.Q.GetLiveSipRecordingByCall(ctx, id)
		if err != nil {
			if !db.IsNotFound(err) {
				slog.WarnContext(ctx, "sip recording: look up on hang-up", "call", id, "err", err)
			}
			return
		}
		s.stopPhone(ctx, rec, "hangup")
	}()
}

func (s *Service) startPhone(ctx context.Context, id uuid.UUID) {
	call, err := s.db.Q.GetSipCall(ctx, id)
	if err != nil {
		slog.WarnContext(ctx, "sip recording: read the call", "call", id, "err", err)
		return
	}
	if !pbconv.SipCallLive(call.Status) {
		return
	}
	in := call.Direction == "in"
	room := call.LkRoom
	if !in {
		if call.RoomID == nil {
			return // the connection test
		}
		room = voice.RoomName(call.WorkspaceID, *call.RoomID)
	}
	acc, err := s.db.Q.GetSipAccount(ctx, call.WorkspaceID)
	if err != nil {
		if !db.IsNotFound(err) {
			slog.WarnContext(ctx, "sip recording: read the switches", "call", id, "err", err)
		}
		return
	}
	if (in && !acc.RecordInbound) || (!in && !acc.RecordOutbound) || room == "" {
		return
	}
	if s.PlanInactive != nil && s.PlanInactive(ctx, call.WorkspaceID) {
		return
	}
	if n, err := s.db.Q.CountLiveSipRecordings(ctx); err != nil {
		slog.WarnContext(ctx, "sip recording: count", "err", err)
		return
	} else if n >= int64(s.phone.MaxConcurrent) {
		slog.WarnContext(ctx, "sip recording: too many at once, the call is not recorded", "call", id, "running", n)
		metricPhone.WithLabelValues("skipped_limit").Inc()
		return
	}
	rid, err := uuid.NewV7()
	if err != nil {
		return
	}
	dir := "out"
	if in {
		dir = "in"
	}
	rec, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.SipCallRecording, error) {
		return q.InsertSipCallRecording(ctx, sqlc.InsertSipCallRecordingParams{ID: rid, WorkspaceID: call.WorkspaceID, CallID: call.ID,
			Direction: dir, Number: clip(call.Number, 32), LkRoom: room, File: phoneFile(call.WorkspaceID, rid)})
	})
	if db.IsNotFound(err) {
		return // already recorded (a repeated «connected»)
	}
	if err != nil {
		slog.WarnContext(ctx, "sip recording: insert", "call", id, "err", err)
		return
	}
	out, err := s.store.output(rec.File)
	if err == nil {
		out.FileType = rtc.FileOGG
		var info *rtc.EgressInfo
		if info, err = s.eg.StartAudioRecording(ctx, room, out); err == nil {
			s.phoneStarted(ctx, rec, info.EgressID)
			return
		}
	}
	slog.WarnContext(ctx, "sip recording: start egress, the call is not recorded", "call", id, "room", room, "err", err)
	s.failPhone(ctx, rec, phoneErrEgress)
}

// phoneStarted stores the egress of rec; a call that ended while the egress started is stopped.
func (s *Service) phoneStarted(ctx context.Context, rec sqlc.SipCallRecording, egressID string) {
	upd, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.SipCallRecording, error) {
		return q.MarkSipRecordingStarted(ctx, sqlc.MarkSipRecordingStartedParams{ID: rec.ID, EgressID: &egressID})
	})
	if err != nil {
		slog.WarnContext(ctx, "sip recording: store the egress", "recording", rec.ID, "err", err)
		s.stopEgress(ctx, egressID, "start_not_stored", "phone", "recording", rec.ID)
		return
	}
	metricPhone.WithLabelValues("started").Inc()
	slog.InfoContext(ctx, "sip recording started", "recording", upd.ID, "call", upd.CallID, "egress", egressID, "room", upd.LkRoom)
	if upd.StoppedAt != nil {
		s.stopPhone(ctx, upd, "ended_while_starting") // the hang-up came before the egress id
		return
	}
	if call, err := s.db.Q.GetSipCall(ctx, upd.CallID); err == nil && !pbconv.SipCallLive(call.Status) {
		s.stopPhone(ctx, upd, "ended_while_starting")
	}
}

// stopPhone asks the egress of rec to stop; the file is taken over when it reports the end.
func (s *Service) stopPhone(ctx context.Context, rec sqlc.SipCallRecording, reason string) {
	upd, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.SipCallRecording, error) {
		return q.MarkSipRecordingStopRequested(ctx, rec.ID)
	})
	if err != nil {
		if !db.IsNotFound(err) {
			slog.WarnContext(ctx, "sip recording: stop", "recording", rec.ID, "err", err)
		}
		return
	}
	if upd.EgressID != nil {
		s.stopEgress(ctx, *upd.EgressID, reason, "phone", "recording", upd.ID)
	}
}

func (s *Service) failPhone(ctx context.Context, rec sqlc.SipCallRecording, code string) {
	if _, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.SipCallRecording, error) {
		return q.MarkSipRecordingFailed(ctx, sqlc.MarkSipRecordingFailedParams{ID: rec.ID, Error: code})
	}); err != nil && !db.IsNotFound(err) {
		slog.WarnContext(ctx, "sip recording: mark failed", "recording", rec.ID, "err", err)
	}
	metricPhone.WithLabelValues("failed_" + code).Inc()
}

// handlePhoneEgress takes over a phone recording whose egress ended (webhook); false = the
// egress is not a phone recording's.
func (s *Service) handlePhoneEgress(ctx context.Context, info *rtc.EgressInfo) (bool, error) {
	rec, err := s.db.Q.GetSipRecordingByEgress(ctx, &info.EgressID)
	if db.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return true, err
	}
	return true, s.finishPhone(ctx, rec, info)
}

func phoneLockKey(id uuid.UUID) string { return redisx.Key("siprec:lock:" + id.String()) }

var lockRelease = rueidis.NewLuaScript(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`)

// finishPhone copies the file of an ended egress into the Disk, once (a Valkey lock: the
// webhook and the reconcile may both come). A storage that does not answer, or a Disk error
// that may pass, leaves the row for the next reconcile until StorageWait has passed.
func (s *Service) finishPhone(ctx context.Context, rec sqlc.SipCallRecording, info *rtc.EgressInfo) error {
	if rec.Status != "recording" || s.phone == nil {
		return nil
	}
	tok := uuid.NewString()
	if err := s.redis.Do(ctx, s.redis.B().Set().Key(phoneLockKey(rec.ID)).Value(tok).Nx().Px(10*time.Minute).Build()).Error(); err != nil {
		if rueidis.IsRedisNil(err) {
			return nil // another instance takes it now
		}
		return err
	}
	defer func() {
		_ = lockRelease.Exec(context.WithoutCancel(ctx), s.redis, []string{phoneLockKey(rec.ID)}, []string{tok}).Error()
	}()
	rec, err := s.db.Q.GetSipCallRecording(ctx, rec.ID)
	if err != nil || rec.Status != "recording" {
		return err
	}
	waited := s.phoneWaitOver(rec)
	size, err := s.store.stat(ctx, rec.File)
	switch {
	case errors.Is(err, errUnavailable) && !waited:
		return err
	case errors.Is(err, errUnavailable):
		slog.WarnContext(ctx, "sip recording: file storage did not answer, giving up", "recording", rec.ID, "err", err)
		s.failPhone(ctx, rec, phoneErrStorage)
		return nil
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		return err
	case size <= 0:
		slog.WarnContext(ctx, "sip recording: egress ended without a file", "recording", rec.ID, "status", info.Status, "error", info.Error)
		s.failPhone(ctx, rec, phoneErrNoAudio)
		return nil
	}
	ws, err := s.db.Q.GetWorkspace(ctx, rec.WorkspaceID)
	if err != nil {
		return err
	}
	day, name := PhoneName(rec.StartedAt, s.phone.Location, rec.Number, rec.Direction == "in")
	f, err := s.storePhoneFile(ctx, rec, ws.OwnerID, name, size)
	if errors.Is(err, files.ErrNoRoom) {
		slog.WarnContext(ctx, "sip recording: no room in the workspace storage, not stored", "recording", rec.ID, "workspace", rec.WorkspaceID, "bytes", size)
		s.failPhone(ctx, rec, phoneErrQuota)
		return nil
	}
	if err != nil {
		return s.retryPhone(ctx, rec, waited, err)
	}
	item, err := s.phone.Disk.PlaceFile(ctx, rec.WorkspaceID, ws.OwnerID, []disk.Folder{{Name: PhoneRoot, Restricted: true}, {Name: day}}, f, name)
	if err != nil {
		if derr := s.files.DeleteFile(context.WithoutCancel(ctx), f.ID); derr != nil {
			slog.WarnContext(ctx, "sip recording: drop the stored file", "file", f.ID, "err", derr)
		}
		switch {
		case errors.Is(err, disk.ErrPathBlocked):
			slog.WarnContext(ctx, "sip recording: a file holds the folder's name on the Disk", "recording", rec.ID, "workspace", rec.WorkspaceID)
			s.failPhone(ctx, rec, phoneErrBlocked)
			return nil
		case errors.Is(err, moderation.ErrSuspended):
			s.failPhone(ctx, rec, phoneErrDisabled)
			return nil
		}
		return s.retryPhone(ctx, rec, waited, err)
	}
	if _, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.SipCallRecording, error) {
		return q.MarkSipRecordingStored(ctx, sqlc.MarkSipRecordingStoredParams{ID: rec.ID, SizeBytes: size, FileID: &f.ID, DiskItemID: &item.ID})
	}); err != nil {
		slog.WarnContext(ctx, "sip recording: mark stored", "recording", rec.ID, "err", err)
		return nil // the Disk has the file; the raw file stays for the janitor
	}
	metricPhone.WithLabelValues("stored").Inc()
	slog.InfoContext(ctx, "sip recording stored", "recording", rec.ID, "call", rec.CallID, "item", item.ID, "name", item.Name, "bytes", size)
	s.removePhoneFile(ctx, rec)
	return nil
}

// retryPhone: the copy failed for a reason that may pass — the reconcile tries again, until
// StorageWait has passed.
func (s *Service) retryPhone(ctx context.Context, rec sqlc.SipCallRecording, waited bool, err error) error {
	if !waited {
		return err
	}
	slog.WarnContext(ctx, "sip recording: could not store, giving up", "recording", rec.ID, "err", err)
	s.failPhone(ctx, rec, phoneErrStorage)
	return nil
}

func (s *Service) storePhoneFile(ctx context.Context, rec sqlc.SipCallRecording, owner uuid.UUID, name string, size int64) (sqlc.File, error) {
	r, _, err := s.store.open(ctx, rec.File)
	if err != nil {
		return sqlc.File{}, err
	}
	defer func() { _ = r.Close() }()
	return s.files.StoreSystemFile(ctx, rec.WorkspaceID, owner, name, "audio/ogg", r, size)
}

// phoneWaitOver: an ended recording waited StorageWait for its file (from the stop, or from the
// longest a call may last).
func (s *Service) phoneWaitOver(rec sqlc.SipCallRecording) bool {
	end := rec.StartedAt.Add(s.phone.MaxCall)
	if rec.StoppedAt != nil && rec.StoppedAt.Before(end) {
		end = *rec.StoppedAt
	}
	return s.Now().Sub(end) > s.StorageWait
}

func (s *Service) removePhoneFile(ctx context.Context, rec sqlc.SipCallRecording) {
	if rec.File == "" {
		return
	}
	if err := s.store.remove(ctx, rec.File); err != nil {
		slog.WarnContext(ctx, "sip recording: remove the raw file", "recording", rec.ID, "err", err)
		return
	}
	if err := db.GuardExec(ctx, s.db, func(q *sqlc.Queries) error { return q.ForgetSipRecordingFile(ctx, rec.ID) }); err != nil {
		slog.WarnContext(ctx, "sip recording: forget the raw file", "recording", rec.ID, "err", err)
	}
}

// maintainPhone (the worker, with Maintain): starts that never reached the egress fail, egresses
// that ended without a webhook are taken over, a call that ended is stopped again, an egress
// past the longest call is stopped. It returns the egresses and rooms of live phone recordings:
// the meeting reconcile leaves them alone.
func (s *Service) maintainPhone(ctx context.Context) (egresses map[string]bool, rooms map[string]bool) {
	egresses, rooms = map[string]bool{}, map[string]bool{}
	if s.phone == nil {
		return egresses, rooms
	}
	rows, err := s.db.Q.ListLiveSipRecordings(ctx)
	if err != nil {
		slog.WarnContext(ctx, "sip recording: list live", "err", err)
		return egresses, rooms
	}
	now := s.Now()
	for _, rec := range rows {
		rooms[rec.LkRoom] = true
		if rec.EgressID != nil {
			egresses[*rec.EgressID] = true
		}
		if rec.Status == "starting" {
			if now.Sub(rec.StartedAt) > 2*time.Minute {
				s.failPhone(ctx, rec, phoneErrLost)
			}
			continue
		}
		if rec.EgressID == nil || s.eg == nil {
			continue
		}
		list, err := s.eg.ListEgress(ctx, "", *rec.EgressID, false)
		if err != nil {
			slog.WarnContext(ctx, "sip recording: look up egress", "egress", *rec.EgressID, "err", err)
			continue
		}
		if len(list) == 0 || list[0].Ended() {
			info := &rtc.EgressInfo{EgressID: *rec.EgressID, Status: rtc.EgressAborted}
			if len(list) > 0 {
				info = &list[0]
			}
			if err := s.finishPhone(ctx, rec, info); err != nil {
				slog.WarnContext(ctx, "sip recording: take over an ended egress", "recording", rec.ID, "err", err)
			}
			continue
		}
		switch {
		case now.Sub(rec.StartedAt) > s.phone.MaxCall+5*time.Minute:
			s.stopPhone(ctx, rec, "max_duration")
		case rec.StoppedAt != nil && now.Sub(*rec.StoppedAt) > time.Minute:
			s.stopEgress(ctx, *rec.EgressID, "hangup", "phone: repeat stop", "recording", rec.ID)
		case rec.StoppedAt == nil:
			if call, err := s.db.Q.GetSipCall(ctx, rec.CallID); err == nil && !pbconv.SipCallLive(call.Status) {
				s.stopPhone(ctx, rec, "hangup") // the hang-up hook was lost (a restart)
			}
		}
	}
	return egresses, rooms
}

// janitorPhone removes the raw files of finished phone recordings: a stored one's right away
// (normally done when it is stored), a failed one's after KeepFiles.
func (s *Service) janitorPhone(ctx context.Context) {
	if s.phone == nil {
		return
	}
	before := s.Now().Add(-s.KeepFiles)
	rows, err := s.db.Q.ListSipRecordingFilesToDelete(ctx, &before)
	if err != nil {
		slog.WarnContext(ctx, "sip recording: list files to delete", "err", err)
		return
	}
	for _, rec := range rows {
		s.removePhoneFile(ctx, rec)
	}
}
