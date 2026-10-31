#!/usr/bin/env bash
# ONLYOFFICE spike checks (ADR-0143 «План проверки»): fidelity + cost against a local Document
# Server (ports bound to 127.0.0.1; for a remote host run it there and ssh -L 18080 and 18091). Needs Docker and ≥ 8 GB free (the image is ~4 GB unpacked). Local only: ports 18080
# (Document Server) and 18091 (storage stub); never the stand or the cluster.
#
#   tools/office-fidelity/run.sh [OUT_DIR]        # default /tmp/calab-office
#   KEEP=1 tools/office-fidelity/run.sh           # keep the container and the image
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:-/tmp/calab-office}
IMAGE=${IMAGE:-onlyoffice/documentserver:10.0.0.1}
PY_IMAGE=python:3.12-alpine
NAME=calab-ds-spike
mkdir -p "$OUT"

free_gb=$(df -g "$OUT" | awk 'NR==2 {print $4}')
if [ "${free_gb:-0}" -lt 8 ]; then echo "only ${free_gb} GB free, need 8" >&2; exit 1; fi

# The JWT secret lives only in OUT/ds.env (outside the repository).
if [ ! -f "$OUT/ds.env" ]; then echo "JWT_SECRET=$(openssl rand -hex 32)" > "$OUT/ds.env"; chmod 600 "$OUT/ds.env"; fi

cleanup() {
  if [ "${KEEP:-0}" != 1 ]; then
    docker rm -f -v "$NAME" "$NAME-harness" >/dev/null 2>&1 || true
    docker network rm "$NAME" >/dev/null 2>&1 || true
    docker image rm "$IMAGE" "$PY_IMAGE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

VENV=${VENV:-/tmp/calab-office-venv}
[ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install -q openpyxl python-docx python-pptx; }
"$VENV/bin/python" -I "$ROOT/tools/office-fidelity/fixtures.py" "$OUT"

docker rm -f -v "$NAME" "$NAME-harness" >/dev/null 2>&1 || true
docker network create "$NAME" >/dev/null 2>&1 || true
# The storage + callback stub (harness.py) on the same network: the server reaches it by name.
docker run -d --name "$NAME-harness" --network "$NAME" -p 127.0.0.1:18091:8000 --env-file "$OUT/ds.env" \
  -e DATA=/data -e DS_INTERNAL="http://$NAME" -v "$OUT:/data" -v "$ROOT/tools/office-fidelity/harness.py:/harness.py:ro" \
  "$PY_IMAGE" python -u /harness.py >/dev/null
docker run -d --name "$NAME" --network "$NAME" -p 127.0.0.1:18080:80 \
  --env-file "$OUT/ds.env" -e JWT_ENABLED=true -e JWT_HEADER=Authorization -e JWT_IN_BODY=false \
  -e ALLOW_PRIVATE_IP_ADDRESS=true -e PLUGINS_ENABLED=false \
  -v "$ROOT/infra/office:/var/www/onlyoffice/documentserver/web-apps/apps/calab:ro" \
  "$IMAGE" >/dev/null
echo "waiting for the Document Server…"
until [ "$(curl -fsS http://localhost:18080/healthcheck 2>/dev/null)" = "true" ]; do sleep 3; done
docker stats --no-stream --format '{{.Name}} idle: {{.MemUsage}} cpu {{.CPUPerc}}' "$NAME" | tee "$OUT/ds-idle.txt"

# Container memory with one open document: sampled while the bench idles in the editor.
( sleep 60; docker stats --no-stream --format '{{.Name}} one document open: {{.MemUsage}} cpu {{.CPUPerc}}' "$NAME" | tee "$OUT/ds-open.txt" ) &
node "$ROOT/tools/office-fidelity/bench.mjs" --ds http://localhost:18080 --secret-file "$OUT/ds.env" \
  --storage http://localhost:18091 --storage-for-ds "http://$NAME-harness:8000" --out "$OUT"
wait

for f in vacations.xlsx contract.docx deck.pptx staff.csv; do
  for kind in convert editor6 editor2 legacy; do
    [ -f "$OUT/$kind-$f" ] && "$VENV/bin/python" -I "$ROOT/tools/office-fidelity/compare.py" "$OUT/$f" "$OUT/$kind-$f" | sed "s/^/[$kind] /" || true
  done
done
echo "report: $OUT/bench.json, screenshots: $OUT/shot-*.png"
