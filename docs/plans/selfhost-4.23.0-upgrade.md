# Self-host 4.23.0 upgrade contract (2026-11-17, revision 1.1)

Owner request: update DrCramer/calab, its Windows client and this host, preserving
custom changes. Lead decision: merge published upstream v4.23.0 at
e821645c6b745812e9c86c64086083370db54e52 onto fork 61f4b270; exclude later main commits.

## Scope and invariants

- Preserve screen-share enum IDs 1–12, explicit quality ordering, presets through
  2160p60/Original60, room/plan checks, first-run server and fork-only update feed.
- Workspace media defaults must clamp presets by quality, not numeric enum ID;
  use the existing allowedStreamPreset helper and verify legacy/new enum ordering.
- Applied SQL versions through 152 are immutable. Append upstream 151–155 as
  153–157, byte-identical bodies; inspect hard-coded migration references in tests.
- Preserve production secrets, persistent volumes, quotas and MAX_FILE_SIZE_MB=1908.
  Keep fork Config/Compose default 2048 MiB and upstream upload permission checks.
- Adopt upstream client/media fixes and gateway routing/security changes, including
  exact /mcp, its discovery metadata and private /d/* SPA pages, behind NPM.
- Move the two fork-only ADRs to reserved 9001/9002 filenames to prevent recurring
  upstream numbering collisions; their existing contracts are unchanged.
- Upgrade API/web only. Keep NPM TCP 80/443, database/cache/media containers,
  unrelated projects, firewall and the dirty original worktree unchanged.
- Allowed writes: isolated update worktree, fork branch/main/tag/release, new
  versioned runtime and task-owned backup/test databases. No upstream writes,
  commercial checks bypass, licence/NOTICE removal or bot announcement.

## Acceptance and recovery

Use project make gen; check generated drift and preserved contracts. Require PR
and exact main CI (PG17 integration, Go race/vet/lint, frontend types/tests,
protocol/drift/vulnerability checks) and Windows installer/start/defaults smoke.
Restore production backup into an isolated DB; apply appended migrations and
compare core counts and fresh-schema objects, documenting equivalent expressions.
Back up DB/files/config privately, stop old API, take final consistent backups,
migrate and replace API/web. Check public API/version, readiness, exact web assets,
private/discovery paths, Gateway HELLO, logs, health and unchanged dependencies/NPM.
Publish fork Windows installer/blockmap/latest.yml/checksums only after all gates;
verify anonymous downloads and feed integrity. Actual media on user PCs remains
unverified. Rollback requires matching old DB plus old image/web; avoid losing new
writes. Lead works alone, per owner's no-subagent decision. Claude-only usage
statistics are not evidence of Codex cost; bot announcement was declined earlier.
