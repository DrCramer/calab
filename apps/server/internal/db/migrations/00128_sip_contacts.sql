-- The phone book of the telephony section (ADR-0137 §2, stage T2).
--
-- sip_contacts        a company or a person the workspace calls / is called by: name and / or
--                     company, a note. ≤ 10 000 per workspace (the API). sort_group / sort_key
--                     order the list: Cyrillic names first, then Latin, then the rest (the name,
--                     else the company, lower case). Kept as long as the call journal
--                     (sip_accounts.retention_months): a contact none of whose numbers called or
--                     was called and that nobody edited within the period is deleted by the
--                     hourly retention worker.
-- sip_contact_phones  the contact's numbers in E.164, ≤ 10 per contact (the API), in its order
--                     (position); a number belongs to one contact of the workspace, so caller
--                     ID is unambiguous.
-- sip_fold(text)      case folding for the list's order and its search that does not depend on
--                     the database's locale: lower() of a C-locale database leaves Cyrillic as it
--                     is, so the Cyrillic capitals are mapped explicitly (and ё to е — people
--                     type either). search_key holds the folded name and company (a substring
--                     search over ≤ 10 000 rows of one workspace: no index — a trigram index
--                     would skip Cyrillic on a C-locale database too).

-- +goose Up
-- +goose StatementBegin
CREATE FUNCTION sip_fold(t text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
    SELECT translate(lower(t), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯІЇЄҐЎё',
                               'абвгдеежзийклмнопрстуфхцчшщъыьэюяіїєґўе')
$$;
-- +goose StatementEnd

CREATE TABLE sip_contacts (
    id           uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text NOT NULL DEFAULT '' CHECK (char_length(name) <= 128),
    company      text NOT NULL DEFAULT '' CHECK (char_length(company) <= 128),
    note         text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
    created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    updated_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    sort_key     text GENERATED ALWAYS AS (sip_fold(CASE WHEN name <> '' THEN name ELSE company END)) STORED,
    search_key   text GENERATED ALWAYS AS (sip_fold(name) || E'\n' || sip_fold(company)) STORED,
    sort_group   smallint GENERATED ALWAYS AS (
        CASE WHEN lower(CASE WHEN name <> '' THEN name ELSE company END) ~ '^[а-яёА-ЯЁ]' THEN 0
             WHEN lower(CASE WHEN name <> '' THEN name ELSE company END) ~ '^[a-zA-Z]' THEN 1
             ELSE 2 END) STORED,
    CHECK (name <> '' OR company <> ''),
    UNIQUE (workspace_id, id)
);
CREATE INDEX sip_contacts_list_idx ON sip_contacts (workspace_id, sort_group, sort_key COLLATE "C", id);
CREATE INDEX sip_contacts_created_by_idx ON sip_contacts (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX sip_contacts_updated_by_idx ON sip_contacts (updated_by) WHERE updated_by IS NOT NULL;

CREATE TABLE sip_contact_phones (
    contact_id   uuid NOT NULL,
    workspace_id uuid NOT NULL,
    number       text NOT NULL CHECK (number ~ '^\+[1-9][0-9]{6,14}$'),
    label        text NOT NULL DEFAULT 'other' CHECK (label IN ('mobile', 'work', 'home', 'other')),
    position     smallint NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 99),
    PRIMARY KEY (contact_id, number),
    UNIQUE (workspace_id, number),
    FOREIGN KEY (workspace_id, contact_id) REFERENCES sip_contacts (workspace_id, id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE sip_contact_phones;
DROP TABLE sip_contacts;
DROP FUNCTION sip_fold(text);
