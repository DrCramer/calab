-- +goose NO TRANSACTION
-- Disk search (ADR-0062, section "disk"; the pattern of 00064 and 00091): a trigram index over
-- the names of live Disk items (typos, substrings). Partial on live items (trashed_at IS NULL:
-- the descendants of a trashed folder carry the mark too), so the search query repeats the
-- predicate. pg_trgm exists since 00064.
--
-- Built CONCURRENTLY (no write lock on disk_items); an index left INVALID by an interrupted build
-- is dropped first so that a retry builds it again.

-- +goose Up
SET lock_timeout = '10s';

-- +goose StatementBegin
DO $$
DECLARE
    ix text;
BEGIN
    FOR ix IN
        SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE NOT i.indisvalid AND c.relname = 'disk_items_name_trgm_idx'
    LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', ix);
    END LOOP;
END
$$;
-- +goose StatementEnd

RESET lock_timeout;

CREATE INDEX CONCURRENTLY IF NOT EXISTS disk_items_name_trgm_idx ON disk_items USING gin (name gin_trgm_ops)
    WHERE trashed_at IS NULL;

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS disk_items_name_trgm_idx;
