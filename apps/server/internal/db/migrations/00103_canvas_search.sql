-- +goose NO TRANSACTION
-- Canvas search (ADR-0107 §6, the pattern of 00091): a full-text index over the name and the text
-- of live canvases and folders (russian + simple, like wiki_pages_search_idx) and a trigram index
-- over the name (typos, substrings). The expressions must stay those of search.CanvasVector and
-- queries/canvas.sql SearchCanvasItems; both are partial on live items (trashed_at IS NULL), so
-- the queries repeat the predicate. pg_trgm exists since 00064.
--
-- Built CONCURRENTLY (no write lock on canvas_items); an index left INVALID by an interrupted
-- build is dropped first so that a retry builds it again.

-- +goose Up
SET lock_timeout = '10s';

-- +goose StatementBegin
DO $$
DECLARE
    ix text;
BEGIN
    FOR ix IN
        SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE NOT i.indisvalid AND c.relname IN ('canvas_items_search_idx', 'canvas_items_name_trgm_idx')
    LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', ix);
    END LOOP;
END
$$;
-- +goose StatementEnd

RESET lock_timeout;

CREATE INDEX CONCURRENTLY IF NOT EXISTS canvas_items_search_idx ON canvas_items
    USING gin ((to_tsvector('russian', name || ' ' || plain_text) || to_tsvector('simple', name || ' ' || plain_text)))
    WHERE trashed_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS canvas_items_name_trgm_idx ON canvas_items USING gin (name gin_trgm_ops)
    WHERE trashed_at IS NULL;

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS canvas_items_name_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS canvas_items_search_idx;
