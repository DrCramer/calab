# Self-host 4.18.0 upgrade contract (2026-11-08, revision 1)

Owner request: update the DrCramer/calab fork, publish its Windows client and
upgrade this host. Lead decision: integrate upstream v4.18.0 at
6b1281a542c415865f5a497b5f396f45f3f6669c onto fork ff30ce5c.

## Scope and invariants

- Preserve custom screen presets, protobuf numbers 1–12, explicit quality ordering,
  room/plan checks, default server and fork-only updater; no licence changes.
- Existing migrations through 140 are immutable. Append upstream 139–150 with
  an offset of +2 (141–152; preserve upstream gaps), with identical SQL. Verify
  migration-number references in tests. No history rewriting on this upgrade.
- Adopt upstream upload overrides, administrator hard cap and streamed deadlines;
  preserve this installation's MAX_FILE_SIZE_MB=1908 and all saved secrets/quotas.
- Bring the NPM web gateway up to current upstream routing/security headers,
  including MCP discovery, sensitive SPA cache policy and blob frame support.
- Keep NPM, host TCP 80/443, database/cache/media containers, their ports and
  persistent volumes unchanged. Upgrade API and web only from the verified SHA.
- Allowed: isolated update worktree, fork branches/releases, new versioned runtime
  directory and task-owned backup/test databases. Forbidden: upstream writes,
  dirty original checkout edits, firewall resets, foreign resources/cache pruning.

## Acceptance and recovery

Generate proto/SQL using make gen; inspect drift, preserved contracts and licence
texts; require full fork CI on PR/main and Windows installer/startup/defaults smoke.
Clone the production database and apply appended migrations before cutover; compare
core counts and fresh-schema objects. Back up DB, files and runtime/config privately,
then take a final DB dump with API stopped before production migrations. Verify
API version/readiness, web assets, Gateway HELLO, logs and unchanged NPM/dependencies.
Publish Windows installer, blockmap, checksums and latest.yml on DrCramer/calab only;
verify public hashes/feed. Do not send a bot announcement (owner declined).
Rollback needs the prior image/web plus matching DB restore; avoid discarding new
writes. Real Windows audio/screen sharing requires user devices and is unverified.
