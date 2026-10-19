#!/bin/sh
# Canvas REST walkthrough with the exact requests of apps/desktop/src/renderer/services/canvas.ts
# (H8, docs/plans/canvas-v1-tasks.md). Usage: tools/canvas-walk.sh http://127.0.0.1:3078 [dump-dir]
# Needs a running server with REGISTRATION_MODE=open and curl + jq. Prints one line per step, exits 1
# on a mismatch. With a dump dir every answer is saved there as <name>.json — the fixtures of
# apps/desktop/src/renderer/services/__fixtures__/canvas (canvas.wire.test.ts). The sync socket, the
# versions, the preview and the text search need a document: lib/canvasSync.live.test.ts covers them.
set -eu
[ -z "${WALK_TRACE:-}" ] || set -x
B=${1:-http://127.0.0.1:3078}
DUMP=${2:-}
J='content-type: application/json'
TMP=${TMPDIR:-/tmp}/canvas-walk.$$
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT
[ -z "$DUMP" ] || mkdir -p "$DUMP"
fail() { echo "FAIL: $*" >&2; exit 1; }
want() { [ "$2" = "$3" ] || fail "$1: got '$2', want '$3'"; echo "ok  $1"; }
# keep NAME — saves the last answer ($TMP/last) as a fixture
keep() { [ -z "$DUMP" ] || cp "$TMP/last" "$DUMP/$1.json"; }
# call AS METHOD URL [json-body] — AS is the Authorization header of A or B; body to $TMP/last, prints the status
call() {
  h=$1; m=$2; u=$3; shift 3
  if [ $# -gt 0 ]; then curl -s -o "$TMP/last" -w '%{http_code}' -X "$m" "$u" -H "$h" -H "$J" -d "$1"
  else curl -s -o "$TMP/last" -w '%{http_code}' -X "$m" "$u" -H "$h"; fi
}
register() { # EMAIL NAME → the response body
  curl -sf -X POST "$B/api/auth/register" -H "$J" -d "{\"email\":\"$1\",\"password\":\"h8-password-1\",\"displayName\":\"$2\"}"
}
VIEW=2199023255552
WRITE=4398046511104
OWNER=15393162788864 # view + write + manage
MEMBER=6597069766656 # view + write
S=$(date +%s)
RA=$(register "h8a-$S@example.com" "Alice H8")
TA=$(echo "$RA" | jq -r .tokens.accessToken)
UA=$(echo "$RA" | jq -r .me.user.id)
RB=$(register "h8b-$S@example.com" "Bob H8")
TB=$(echo "$RB" | jq -r .tokens.accessToken)
A="authorization: Bearer $TA"
Bo="authorization: Bearer $TB"
WS=$(curl -sf -X POST "$B/api/workspaces" -H "$A" -H "$J" -d "{\"slug\":\"h8-$S\",\"name\":\"H8\"}" | jq -r '.workspace.id')
UB=$(echo "$RB" | jq -r .me.user.id)
# invitation → the second user joins as a member
CODE=$(curl -sf -X POST "$B/api/workspaces/$WS/invites" -H "$A" -H "$J" -d '{}' | jq -r .invite.code)
want "invite join: 200" "$(call "$Bo" POST "$B/api/invites/$CODE/join")" "200"
W="$B/api/workspaces/$WS/canvas"

# createItem: POST …/canvas/items {parentId, kind, name}; the client creates an untitled canvas (name "")
want "create untitled: 201" "$(call "$A" POST "$W/items" '{"parentId":"","kind":"CANVAS_ITEM_KIND_CANVAS","name":""}')" "201"
keep create-untitled
UNT=$(jq -r .item.id "$TMP/last")
want "untitled name kept empty" "$(jq -r '.item.name' "$TMP/last")" ""
want "owner bits (view+write+manage)" "$(jq -r '.item.myBits' "$TMP/last")" "$OWNER"
want "untitled kind" "$(jq -r '.item.kind' "$TMP/last")" "CANVAS_ITEM_KIND_CANVAS"
want "create folder: 201" "$(call "$A" POST "$W/items" '{"parentId":"","kind":"CANVAS_ITEM_KIND_FOLDER","name":"Продукт"}')" "201"
F=$(jq -r .item.id "$TMP/last")
want "folder kind" "$(jq -r '.item.kind' "$TMP/last")" "CANVAS_ITEM_KIND_FOLDER"
BODY="{\"parentId\":\"$F\",\"kind\":\"CANVAS_ITEM_KIND_CANVAS\",\"name\":\"Дорожная карта\"}"
want "canvas in folder: 201" "$(call "$A" POST "$W/items" "$BODY")" "201"
K=$(jq -r .item.id "$TMP/last")
BODY="{\"parentId\":\"$K\",\"kind\":\"CANVAS_ITEM_KIND_CANVAS\",\"name\":\"x\"}"
want "canvas in a canvas refused: 409" "$(call "$A" POST "$W/items" "$BODY")" "409"
# loadChildren: GET …/items?parent=&cursor=&trashed= (top level: no parent); has_children on the row
call "$A" GET "$W/items" > /dev/null; keep list-top
want "top listing order" "$(jq -r '[.items[].name] | join(",")' "$TMP/last")" ",Продукт"
want "has_children" "$(jq -r '.items[1].hasChildren' "$TMP/last")" "true"
want "nextCursor empty" "$(jq -r '.nextCursor // ""' "$TMP/last")" ""
call "$A" GET "$W/items?parent=$F" > /dev/null; keep list-children
want "children listing" "$(jq -r '.items[0].id == "'"$K"'"' "$TMP/last")" "true"
# loadItem: GET /api/canvas/items/{id} + …/path
call "$A" GET "$B/api/canvas/items/$K" > /dev/null
want "get: owner bits" "$(jq -r '.item.myBits' "$TMP/last")" "$OWNER"
call "$A" GET "$B/api/canvas/items/$K/path" > /dev/null; keep path
want "path crumbs" "$(jq -r '[.items[].name] | join("/")' "$TMP/last")" "Продукт/Дорожная карта"
# the member: sees the tree with VIEW|WRITE, edits nothing structural of Alice's items
call "$Bo" GET "$B/api/canvas/items/$K" > /dev/null
want "member bits (view+write)" "$(jq -r '.item.myBits' "$TMP/last")" "$MEMBER"
want "member rename: 403" "$(call "$Bo" PATCH "$B/api/canvas/items/$K" '{"name":"Hacked"}')" "403"
keep forbidden
want "member trash: 403" "$(call "$Bo" POST "$B/api/canvas/items/$K/trash")" "403"
# update: rename (PATCH), move (parentId + position)
call "$A" PATCH "$B/api/canvas/items/$K" '{"name":"Дорожная карта Q1"}' > /dev/null; keep patch-rename
want "rename" "$(jq -r '.item.name' "$TMP/last")" "Дорожная карта Q1"
call "$A" PATCH "$B/api/canvas/items/$K" '{"parentId":"","position":0}' > /dev/null; keep patch
want "move to top at 0" "$(jq -r '(.item.parentId // "") + (.item.position // 0 | tostring)' "$TMP/last")" "0"
call "$A" GET "$W/items" > /dev/null
want "moved first" "$(jq -r '.items[0].id == "'"$K"'"' "$TMP/last")" "true"
BODY="{\"parentId\":\"$K\"}"
want "move into its own subtree refused: 409" "$(call "$A" PATCH "$B/api/canvas/items/$F" "$BODY")" "409"
call "$A" PATCH "$B/api/canvas/items/$K" "{\"parentId\":\"$F\",\"position\":0}" > /dev/null; keep patch-move
want "move back into the folder" "$(jq -r '.item.parentId == "'"$F"'"' "$TMP/last")" "true"
# access: PUT …/permissions {entries, restricted?} (callEmpty), then GET
BODY="{\"entries\":[{\"targetType\":\"PERMISSION_TARGET_TYPE_USER\",\"targetId\":\"$UB\",\"deny\":\"$WRITE\"}]}"
want "perms PUT (deny write to Bob)" "$(call "$A" PUT "$B/api/canvas/items/$K/permissions" "$BODY")" "200"
call "$A" GET "$B/api/canvas/items/$K/permissions" > /dev/null; keep perms
want "perms entry" "$(jq -r '.entries[0].targetId == "'"$UB"'" and .entries[0].deny == "'"$WRITE"'"' "$TMP/last")" "true"
want "perms restricted off" "$(jq -r '.restricted // false' "$TMP/last")" "false"
call "$Bo" GET "$B/api/canvas/items/$K" > /dev/null; keep get-view-only
want "Bob is view-only now" "$(jq -r '.item.myBits' "$TMP/last")" "$VIEW"
want "Bob sees the override" "$(jq -r '.item.shared // false' "$TMP/last")" "true"
want "member reads perms: 403" "$(call "$Bo" GET "$B/api/canvas/items/$K/permissions")" "403"
want "perms cleared" "$(call "$A" PUT "$B/api/canvas/items/$K/permissions" '{"entries":[]}')" "200"
call "$Bo" GET "$B/api/canvas/items/$K" > /dev/null
want "Bob can write again" "$(jq -r '.item.myBits' "$TMP/last")" "$MEMBER"
# private (restricted) canvas of Bob: Alice, owner of the workspace, does not see it
want "Bob creates: 201" "$(call "$Bo" POST "$W/items" '{"parentId":"","kind":"CANVAS_ITEM_KIND_CANVAS","name":"Secret"}')" "201"
SEC=$(jq -r .item.id "$TMP/last")
want "Bob makes it private" "$(call "$Bo" PATCH "$B/api/canvas/items/$SEC" '{"restricted":true}')" "200"
keep patch-restricted
want "private: restricted flag" "$(jq -r '.item.restricted' "$TMP/last")" "true"
want "private: Alice gets 404" "$(call "$A" GET "$B/api/canvas/items/$SEC")" "404"
call "$A" GET "$W/items" > /dev/null
want "private: not in Alice's listing" "$(jq -r '[.items[].name] | index("Secret")' "$TMP/last")" "null"
# settings: owner_sees_private lets Alice see it; take-over needs its creator gone
want "owner sees private: on" "$(call "$A" PATCH "$B/api/workspaces/$WS" '{"ownerSeesPrivate":true}')" "200"
want "private: Alice sees it" "$(call "$A" GET "$B/api/canvas/items/$SEC")" "200"
want "take-over while Bob is a member: 409" "$(call "$A" POST "$B/api/canvas/items/$SEC/take-over")" "409"
# search by name: GET /api/search?q=&scope=&type=canvas&limit=20 (the text needs a snapshot: the live test)
sleep 1
call "$A" GET "$B/api/search?q=%D0%94%D0%BE%D1%80%D0%BE%D0%B6%D0%BD%D0%B0%D1%8F&scope=$WS&type=canvas&limit=20" > /dev/null; keep search
want "search hit by name" "$(jq -r '.sections[0].type + " " + .sections[0].items[0].canvas.itemId' "$TMP/last")" "SEARCH_TYPE_CANVAS $K"
want "search hit path" "$(jq -r '.sections[0].items[0].canvas.path | join("/")' "$TMP/last")" "Продукт"
want "search hit is not a folder" "$(jq -r '.sections[0].items[0].canvas.folder // false' "$TMP/last")" "false"
call "$A" GET "$B/api/search?q=%D0%9F%D1%80%D0%BE%D0%B4%D1%83%D0%BA%D1%82&scope=$WS&type=canvas&limit=20" > /dev/null; keep search-folder
want "search folder hit" "$(jq -r '.sections[0].items[0].canvas.itemId == "'"$F"'" and .sections[0].items[0].canvas.folder' "$TMP/last")" "true"
# journal, versions (empty before the first snapshot), settings
call "$A" GET "$B/api/canvas/items/$K/activity" > /dev/null; keep activity
want "activity kinds" "$(jq -r '[.activities[].kind] | contains(["CANVAS_ACTIVITY_KIND_CREATE","CANVAS_ACTIVITY_KIND_RENAME","CANVAS_ACTIVITY_KIND_MOVE"])' "$TMP/last")" "true"
call "$A" GET "$W/activity" > /dev/null; keep activity-workspace
want "workspace journal" "$(jq -r '.activities | length > 0' "$TMP/last")" "true"
want "workspace journal of one actor" "$(call "$A" GET "$W/activity?actor=$UA")" "200"
want "workspace journal: member 403" "$(call "$Bo" GET "$W/activity")" "403"
call "$A" GET "$B/api/canvas/items/$K/versions" > /dev/null; keep versions-empty
want "versions empty" "$(jq -r '(.versions // []) | length' "$TMP/last")" "0"
want "settings PUT" "$(call "$A" PUT "$W/settings" '{"trashDays":7}')" "200"
call "$A" GET "$W/settings" > /dev/null; keep settings
want "settings GET" "$(jq -r .trashDays "$TMP/last")" "7"
want "settings: member 403" "$(call "$Bo" PUT "$W/settings" '{"trashDays":1}')" "403"
# trash → listing trashed=1 → restore; a live canvas is not deletable forever (409)
want "trash: 200" "$(call "$A" POST "$B/api/canvas/items/$F/trash")" "200"
keep trash
want "trashed root" "$(jq -r '.item.trashedRoot' "$TMP/last")" "true"
call "$A" GET "$W/items?trashed=1" > /dev/null; keep list-trash
want "trash listing (roots only)" "$(jq -r '[.items[].id] == ["'"$F"'"]' "$TMP/last")" "true"
want "trashed canvas is not listed" "$(call "$A" GET "$W/items?parent=$F" >/dev/null; jq -r '(.items // []) | length' "$TMP/last")" "0"
want "restore" "$(call "$A" POST "$B/api/canvas/items/$F/restore")" "200"
want "delete live item refused" "$(call "$A" DELETE "$B/api/canvas/items/$F")" "409"
call "$A" POST "$B/api/canvas/items/$F/trash" > /dev/null
want "delete forever" "$(call "$A" DELETE "$B/api/canvas/items/$F")" "204"
call "$A" POST "$B/api/canvas/items/$UNT/trash" > /dev/null
call "$A" POST "$W/trash/empty" > /dev/null; keep trash-empty
want "empty trash" "$(jq -r .deleted "$TMP/last")" "1"
want "gone: 404" "$(call "$A" GET "$B/api/canvas/items/$F")" "404"
keep not-found
want "inner canvas went with the folder" "$(call "$A" GET "$B/api/canvas/items/$K")" "404"
# take-over: once Bob has left, Alice (owner, owner_sees_private on) becomes the owner of the private canvas
want "Bob is removed" "$(call "$A" DELETE "$B/api/workspaces/$WS/members/$UB")" "204"
want "take-over: 200" "$(call "$A" POST "$B/api/canvas/items/$SEC/take-over")" "200"
keep take-over
want "take-over: new owner" "$(jq -r '.item.ownerId == "'"$UA"'"' "$TMP/last")" "true"
want "sync without upgrade: 426" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/canvas/items/$SEC/sync")" "426"
echo "ALL OK"
