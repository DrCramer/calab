package office

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Access during an open session (ADR-0143 «Угрозы»: a downgrade). A save is refused when its
// author lost «Правка» (save); besides, whoever is connected is rechecked when somebody joins
// (status 1) and by the sweep every SweepInterval: a member without DISK_VIEW, or an editor
// without DISK_WRITE, is dropped from the session by the Document Server's command service.

// SweepInterval is how often the live sessions are rechecked.
const SweepInterval = time.Minute

// RunSweep rechecks the live sessions every interval until ctx is done (every API instance runs
// it; drops are idempotent).
func (s *Service) RunSweep(ctx context.Context, interval time.Duration) {
	if !s.cfg.Enabled {
		return
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			items, err := s.sessions.Live(ctx)
			if err != nil {
				slog.WarnContext(ctx, "office: sweep", "err", err)
				continue
			}
			for _, id := range items {
				s.recheck(ctx, id)
			}
		}
	}
}

// recheck drops the users of item's session who lost access. It checks everyone who got a
// configuration of the session, not only the connected editors: the Document Server reports no
// viewers (status 1 lists editors), and a configuration is signed for ConfigTokenTTL, so its
// holder can reconnect after losing access.
//   - no DISK_VIEW: dropped, marks forgotten (once the drop went through);
//   - an edit configuration and no «Правка» now: dropped and its mark turned into a revoked one;
//     a revoked editor is dropped again whenever they show up connected as an editor (a kept
//     edit configuration), while a view configuration they open legitimately stays (viewers
//     are never in Online).
func (s *Service) recheck(ctx context.Context, item uuid.UUID) {
	sess, ok, err := s.sessions.Get(ctx, item)
	if err != nil || !ok {
		return
	}
	editors, revoked, online := idSet(sess.Editors), idSet(sess.Revoked), idSet(sess.Online)
	var users []uuid.UUID
	seen := map[uuid.UUID]bool{}
	for _, list := range [][]uuid.UUID{sess.Online, sess.Editors, sess.Revoked, sess.Viewers} {
		for _, u := range list {
			if !seen[u] {
				seen[u] = true
				users = append(users, u)
			}
		}
	}
	var drop, revoke, forget []uuid.UUID
	for _, u := range users {
		it, err := s.store.ItemFor(ctx, u, item)
		switch {
		case errors.Is(err, ErrNotFound):
			drop, forget = append(drop, u), append(forget, u)
		case err != nil:
			slog.WarnContext(ctx, "office: recheck", "item", item, "err", err)
			return
		case editors[u] || revoked[u]:
			f, _ := FormatOf(it.Name)
			if Mode(it, f, false) == v1.OfficeMode_OFFICE_MODE_EDIT {
				continue
			}
			if editors[u] {
				drop, revoke = append(drop, u), append(revoke, u)
			} else if online[u] {
				drop = append(drop, u)
			}
		}
	}
	if len(drop) == 0 {
		return
	}
	slog.InfoContext(ctx, "office: drop", "item", item, "key", sess.Key, "users", drop)
	if len(revoke) > 0 {
		if err := s.sessions.Revoke(ctx, item, sess.Key, revoke); err != nil {
			slog.WarnContext(ctx, "office: revoke", "item", item, "err", err)
		}
	}
	ids := make([]string, len(drop))
	for i, u := range drop {
		ids[i] = u.String()
	}
	if err := s.command(ctx, map[string]any{"c": "drop", "key": sess.Key, "users": ids}); err != nil {
		slog.WarnContext(ctx, "office: drop", "item", item, "err", err)
		return // the marks stay: the next sweep drops them again
	}
	if len(forget) > 0 {
		if err := s.sessions.Forget(ctx, item, sess.Key, forget); err != nil {
			slog.WarnContext(ctx, "office: forget", "item", item, "err", err)
		}
	}
}

func idSet(ids []uuid.UUID) map[uuid.UUID]bool {
	m := make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		m[id] = true
	}
	return m
}

// command calls the Document Server's command service (POST {internal}/command, the JWT in
// the body: its claims are the command).
func (s *Service) command(ctx context.Context, cmd map[string]any) error {
	var res struct {
		Error int `json:"error"`
	}
	if err := s.postDS(ctx, "/command", cmd, &res); err != nil {
		return err
	}
	// 1: the key is unknown (the session ended meanwhile) — nothing to drop.
	if res.Error != 0 && res.Error != 1 {
		return fmt.Errorf("office: command service error %d", res.Error)
	}
	return nil
}

// postDS posts a signed JSON request to the Document Server and decodes its JSON answer.
func (s *Service) postDS(ctx context.Context, path string, body map[string]any, out any) error {
	tok, err := signConfig(s.cfg.Secret, body, requestTokenTTL)
	if err != nil {
		return err
	}
	signed := make(map[string]any, len(body)+1)
	for k, v := range body {
		signed[k] = v
	}
	signed["token"] = tok
	raw, err := json.Marshal(signed)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.DocsInternalURL+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	res, err := s.HTTP.Do(req)
	if err != nil {
		return redactURL(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("office: document server %s answered %d", path, res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(out)
}
