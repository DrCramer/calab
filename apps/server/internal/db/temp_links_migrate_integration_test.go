//go:build integration

package db

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// TestTempLinksArchiveBackfill (ADR-0107, migration 00103): the links the archive of a temporary
// room now in the archive revoked (revoked_at = archived_at) and that were usable then are
// marked archive_revoked; links revoked by hand, meeting links, used-up ones and those of
// live rooms are not.
func TestTempLinksArchiveBackfill(t *testing.T) {
	ctx := context.Background()
	adminURL := envOr("TEST_PG_URL", envOr("TEST_DATABASE_URL", "postgres://calaba:calaba@localhost:55432/calaba"))
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatalf("postgres unavailable: %v", err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var b [4]byte
	_, _ = rand.Read(b[:])
	name := "calaba_mig_" + hex.EncodeToString(b[:])
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)") }()
	u, _ := url.Parse(adminURL)
	u.Path = "/" + name
	d, err := Connect(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	must := func(sql string, args ...any) {
		t.Helper()
		if _, err := d.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	if err := d.MigrateTo(ctx, 102); err != nil {
		t.Fatal(err)
	}
	owner, ws := uuid.New(), uuid.New()
	must(`INSERT INTO users (id, email, display_name) VALUES ($1, 'o@example.com', 'o')`, owner)
	must(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, 'mig-links', 'W', $2)`, ws, owner)
	room := func(archived bool) uuid.UUID {
		id := uuid.New()
		must(`INSERT INTO rooms (id, workspace_id, name, type, expires_at, archived_at)
		      VALUES ($1, $2, 'r', 'voice', '2026-10-01 12:00+00', CASE WHEN $3 THEN '2026-10-01 11:00+00'::timestamptz END)`, id, ws, archived)
		return id
	}
	arch, live := room(true), room(false)
	link := func(roomID uuid.UUID, code, expires, revoked string, maxUses, uses int) {
		must(`INSERT INTO room_invites (room_id, code, created_by, expires_at, revoked_at, max_uses, uses, allow_bits)
		      VALUES ($1, $2, $3, NULLIF($4, '')::timestamptz, NULLIF($5, '')::timestamptz, $6, $7, 1)`, roomID, code, owner, expires, revoked, maxUses, uses)
	}
	const at = "2026-10-01 11:00+00"
	link(arch, "bound", "2026-10-01 12:00+00", at, 0, 0)
	link(arch, "never", "", at, 0, 0)
	link(arch, "ahead", "2026-12-01 00:00+00", at, 0, 0)
	link(arch, "expired", "2026-10-01 10:00+00", at, 0, 0) // died on its own before the archive
	link(arch, "byhand", "2026-10-01 12:00+00", "2026-10-01 10:30+00", 0, 0)
	link(arch, "usedup", "", at, 2, 2)
	link(live, "live", "", at, 0, 0)
	if err := d.MigrateTo(ctx, 103); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"bound": true, "never": true, "ahead": true, "expired": false, "byhand": false, "usedup": false, "live": false}
	for code, w := range want {
		var got bool
		if err := d.Pool.QueryRow(ctx, `SELECT archive_revoked FROM room_invites WHERE code = $1`, code).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != w {
			t.Errorf("%s: archive_revoked %v, want %v", code, got, w)
		}
	}
}
