#!/usr/bin/env bash
# Daily backup of the stand (run by calaba-backup.timer; see docs/06-deployment.md "Резервные копии").
#   - Postgres: pg_dump -Fc                 -> $BACKUP_DIR/pg/calaba-<ts>.dump
#   - files volume (uploads): tar.zst       -> $BACKUP_DIR/files/files-<ts>.tar.zst
#   - NPM owns TLS certificates and has its own backup/lifecycle
#   - infra/docker/.env + .env.accounts     -> $BACKUP_DIR/config/env-<ts>.tar.zst (secrets: a restore
#     without JWT/DB/LiveKit secrets is not the same stand; offsite MUST be an rclone *crypt* remote)
#   - retention: RETENTION_DAYS (default 14)
#   - offsite: if OFFSITE_RCLONE_REMOTE is set (in infra/docker/.env), `rclone sync` of $BACKUP_DIR there
#   - disk guard: warns (journal + exit code 0) when the filesystem of $BACKUP_DIR has < 10 % free
# Local copies protect against logical damage (bad migration, deleted workspace), NOT against
# losing the disk/host — that needs the offsite target (TODO owner).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HERE/../.env"
if [[ -f "$ENV_FILE" ]]; then
  # Only the variables we need; never echo them.
  OFFSITE_RCLONE_REMOTE="${OFFSITE_RCLONE_REMOTE:-$(grep -E '^OFFSITE_RCLONE_REMOTE=' "$ENV_FILE" | cut -d= -f2- || true)}"
fi
BACKUP_DIR="${BACKUP_DIR:-$(cd "$HERE/../../.." && pwd)/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
PROJECT="${COMPOSE_PROJECT:-calaba}"
PG_CONTAINER="${PROJECT}-postgres-1"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

log() { echo "calaba-backup: $*"; }

umask 077
mkdir -p "$BACKUP_DIR/pg" "$BACKUP_DIR/files" "$BACKUP_DIR/config"
chmod 700 "$BACKUP_DIR"

# 1. Postgres: custom format (compressed, restorable per table), written atomically.
tmp="$BACKUP_DIR/pg/.calaba-$TS.dump.part"
docker exec "$PG_CONTAINER" pg_dump -U calaba -d calaba -Fc -Z 6 > "$tmp"
# sanity: the archive must list its TOC
docker exec -i "$PG_CONTAINER" pg_restore --list > /dev/null < "$tmp"
mv "$tmp" "$BACKUP_DIR/pg/calaba-$TS.dump"
log "pg ok: $(du -h "$BACKUP_DIR/pg/calaba-$TS.dump" | cut -f1)"

# 2. Uploaded files. Files are immutable once written (temp + rename), so a live tar is consistent
#    enough; a file uploaded during the tar is simply in the next backup.
tmp="$BACKUP_DIR/files/.files-$TS.tar.zst.part"
docker run --rm --network none --user 0:0 \
  --volume "${PROJECT}_files_data:/data:ro" \
  --entrypoint sh valkey/valkey:9-alpine -c 'tar -C /data -cf - .' \
  | zstd -q -T0 -3 -o "$tmp"
mv "$tmp" "$BACKUP_DIR/files/files-$TS.tar.zst"
log "files ok: $(du -h "$BACKUP_DIR/files/files-$TS.tar.zst" | cut -f1)"

# 3. NPM keeps and backs up its own ACME account and TLS certificates.

# 3b. Secrets/config of the stand.
tar -C "$HERE/.." -cf - .env $( [[ -f "$HERE/../.env.accounts" ]] && echo .env.accounts ) | zstd -q -o "$BACKUP_DIR/config/env-$TS.tar.zst"

# 4. Retention.
find "$BACKUP_DIR/pg" "$BACKUP_DIR/files" "$BACKUP_DIR/config" -type f -mtime "+$RETENTION_DAYS" -print -delete | sed 's/^/calaba-backup: pruned /'
find "$BACKUP_DIR" -name '.*.part' -mmin +120 -delete

# 5. Offsite (optional until the owner picks a target).
if [[ -n "${OFFSITE_RCLONE_REMOTE:-}" ]]; then
  rclone sync --fast-list "$BACKUP_DIR" "$OFFSITE_RCLONE_REMOTE"
  log "offsite ok: $OFFSITE_RCLONE_REMOTE"
else
  log "WARNING: no OFFSITE_RCLONE_REMOTE — backups exist only on this disk"
fi

# 6. Disk guard (shared host: our uploads must not starve the other tenant).
free_pct=$(df --output=pcent "$BACKUP_DIR" | tail -1 | tr -dc 0-9); free_pct=$((100 - free_pct))
if (( free_pct < 10 )); then
  log "WARNING: only ${free_pct}% free on $(df --output=target "$BACKUP_DIR" | tail -1)"
fi
log "done ($TS), disk free ${free_pct}%"
