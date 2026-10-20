package canvas

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

func idp(id *uuid.UUID) string {
	if id == nil {
		return ""
	}
	return id.String()
}

// head is the listing form of an item row.
func head(p sqlc.CanvasItem) sqlc.CanvasItemHead {
	return sqlc.CanvasItemHead{ID: p.ID, WorkspaceID: p.WorkspaceID, ParentID: p.ParentID, Kind: p.Kind, Name: p.Name,
		Position: p.Position, OwnerID: p.OwnerID, Restricted: p.Restricted, Preview: p.Preview, DocSize: p.DocSize,
		NextSeq: p.NextSeq, UpdatedBy: p.UpdatedBy, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt, TrashedAt: p.TrashedAt,
		TrashedBy: p.TrashedBy, TrashedRoot: p.TrashedRoot}
}

func kindProto(kind string) v1.CanvasItemKind {
	switch kind {
	case kindFolder:
		return v1.CanvasItemKind_CANVAS_ITEM_KIND_FOLDER
	case kindCanvas:
		return v1.CanvasItemKind_CANVAS_ITEM_KIND_CANVAS
	}
	return v1.CanvasItemKind_CANVAS_ITEM_KIND_UNSPECIFIED
}

// itemProto converts an item; bits is the caller's (0 in events).
func itemProto(p sqlc.CanvasItemHead, shared, children bool, bits perm.Bits) *v1.CanvasItem {
	out := &v1.CanvasItem{
		Id: p.ID.String(), WorkspaceId: p.WorkspaceID.String(), ParentId: idp(p.ParentID), Kind: kindProto(p.Kind), Name: p.Name,
		OwnerId: idp(p.OwnerID), Restricted: p.Restricted, Shared: shared, Preview: p.Preview,
		UpdatedAt: timestamppb.New(p.UpdatedAt), UpdatedBy: idp(p.UpdatedBy), MyBits: uint64(bits & perm.Canvas),
		HasChildren: children, CreatedAt: timestamppb.New(p.CreatedAt), Position: p.Position, TrashedBy: idp(p.TrashedBy),
		TrashedRoot: p.TrashedRoot, DocSize: uint32(max(p.DocSize, 0)), //nolint:gosec // ≤ 4 MiB
	}
	if p.TrashedAt != nil {
		out.TrashedAt = timestamppb.New(*p.TrashedAt)
	}
	return out
}

// decorated converts items for one caller: whether they are shared and whether they have live
// children. bitsOf gives the caller's bits; children (nil = query) whether each has live children.
func decorated(ctx context.Context, q *sqlc.Queries, items []sqlc.CanvasItemHead, bitsOf func(sqlc.CanvasItemHead) perm.Bits, children map[uuid.UUID]bool) ([]*v1.CanvasItem, error) {
	if len(items) == 0 {
		return nil, nil
	}
	ids := make([]uuid.UUID, len(items))
	for i, p := range items {
		ids[i] = p.ID
	}
	sharedIDs, err := q.ListSharedCanvasItems(ctx, ids)
	if err != nil {
		return nil, err
	}
	shared := make(map[uuid.UUID]bool, len(sharedIDs))
	for _, id := range sharedIDs {
		shared[id] = true
	}
	if children == nil {
		with, err := q.ListCanvasItemsWithChildren(ctx, ids)
		if err != nil {
			return nil, err
		}
		children = make(map[uuid.UUID]bool, len(with))
		for _, id := range with {
			children[id] = true
		}
	}
	out := make([]*v1.CanvasItem, len(items))
	for i, p := range items {
		out[i] = itemProto(p, shared[p.ID], children[p.ID], bitsOf(p))
	}
	return out, nil
}

// one converts a single item for the caller.
func one(ctx context.Context, q *sqlc.Queries, a access) (*v1.CanvasItem, error) {
	out, err := decorated(ctx, q, []sqlc.CanvasItemHead{a.item}, func(sqlc.CanvasItemHead) perm.Bits { return a.bits }, nil)
	if err != nil {
		return nil, err
	}
	return out[0], nil
}

// jsonStruct converts a stored journal side.
func jsonStruct(b []byte) *structpb.Struct {
	if len(b) == 0 {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	s, err := structpb.NewStruct(m)
	if err != nil {
		return nil
	}
	return s
}

var activityKinds = map[string]v1.CanvasActivityKind{
	"create": v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_CREATE, "rename": v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_RENAME,
	"move": v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_MOVE, "share": v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_SHARE,
	"trash": v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_TRASH, "restore": v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_RESTORE,
	"delete": v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_DELETE, "version": v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_VERSION,
	"comment": v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_COMMENT, "resolve": v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_RESOLVE,
}

func activityProto(a sqlc.CanvasActivity) *v1.CanvasActivity {
	return &v1.CanvasActivity{Id: a.ID.String(), WorkspaceId: a.WorkspaceID.String(), ItemId: idp(a.ItemID), ActorId: idp(a.ActorID),
		Kind: activityKinds[a.Kind], Before: jsonStruct(a.Before), After: jsonStruct(a.After), CreatedAt: timestamppb.New(a.CreatedAt),
		ItemName: a.ItemName}
}

func versionProto(v sqlc.ListCanvasVersionsRow) *v1.CanvasVersion {
	out := &v1.CanvasVersion{Id: v.ID.String(), CanvasId: v.CanvasID.String(), CreatedAt: timestamppb.New(v.CreatedAt),
		Size: uint32(max(v.Size, 0))} //nolint:gosec // ≤ 4 MiB
	for _, a := range v.Authors {
		out.AuthorIds = append(out.AuthorIds, a.String())
	}
	return out
}
