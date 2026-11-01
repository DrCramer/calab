package db

import (
	"context"
	"encoding/binary"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// EpochReadReceipts names the start of read receipts in feature_epochs (ADR-0140 §5).
const EpochReadReceipts = "read_receipts"

var epochs sync.Map // name → uuid.UUID, once read (a row never changes)

// FeatureEpoch returns the uuidv7 lower bound of the moment a feature started (feature_epochs):
// ids of messages written from then on compare ≥ it. Cached after the first successful read.
func FeatureEpoch(ctx context.Context, q *sqlc.Queries, name string) (uuid.UUID, error) {
	if v, ok := epochs.Load(name); ok {
		return v.(uuid.UUID), nil
	}
	at, err := q.GetFeatureEpoch(ctx, name)
	if err != nil {
		return uuid.Nil, err
	}
	id := UUIDv7Floor(at)
	epochs.Store(name, id)
	return id, nil
}

// UUIDv7Floor is the smallest uuid whose uuidv7 timestamp is at or after t (millisecond
// precision; the remaining bits zero).
func UUIDv7Floor(t time.Time) uuid.UUID {
	var id uuid.UUID
	var ms [8]byte
	binary.BigEndian.PutUint64(ms[:], uint64(t.UnixMilli())) //nolint:gosec // times after 1970
	copy(id[:6], ms[2:])
	return id
}
