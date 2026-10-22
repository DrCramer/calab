package app

import (
	"context"
	"io"

	"github.com/calaba/calaba/server/internal/blob"
)

// blobFiles opens stored files for the smart tasks' model (boards.FileStore, CBF-75).
type blobFiles struct{ store blob.Store }

func (b blobFiles) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	rc, _, err := b.store.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	return rc, nil
}
