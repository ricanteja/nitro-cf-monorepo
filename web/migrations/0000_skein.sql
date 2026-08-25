-- Skein: a board where you pin material and the app shows you what connects it.
--
-- One migration, no history. Nothing has been deployed, and a reader learns the
-- shape faster from a single file than from a chain of diffs.
--
-- VOCABULARY. A *board* holds *cards*. A card is a note, an image, or a sticker.
-- *Grids* are tables underneath the cards, usable as tier lists or kanban
-- columns. *Links* are the strings between cards. *People* are named faces.
-- Those six nouns are the whole model, and nothing else is invented anywhere in
-- the codebase.

CREATE TABLE boards (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

-- A shareable link. The token IS the credential: whoever holds it gets the
-- permission it carries, which is what a share link is and why it is a uuid
-- rather than anything derived from the board id.
CREATE TABLE shares (
    token       TEXT PRIMARY KEY,
    board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    permission  TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
    created_at  INTEGER NOT NULL
);

-- One link per permission per board, enforced rather than merely intended:
-- minting a second edit link would leave the first live with nothing tracking
-- it, which is how share credentials quietly accumulate.
CREATE UNIQUE INDEX idx_shares_unique ON shares(board_id, permission);

-- A table on the board. Columns and rows are JSON because their shape is the
-- user's to decide — three tier bands one minute, five kanban columns the next
-- — and modelling that relationally would buy nothing but joins.
CREATE TABLE grids (
    id          TEXT PRIMARY KEY,
    board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    title       TEXT,
    x           REAL NOT NULL DEFAULT 0,
    y           REAL NOT NULL DEFAULT 0,
    width       REAL NOT NULL DEFAULT 720,
    height      REAL NOT NULL DEFAULT 320,
    columns     TEXT NOT NULL,
    rows        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

-- Everything pinned to a board.
--
-- LAYERING is derived from `kind`, never stored: grids sit underneath, notes
-- and images above them, stickers on top. A layer column as well would let the
-- two disagree. `z` orders within a layer, so bringing something to the front
-- never lifts it past a sticker.
CREATE TABLE cards (
    id            TEXT PRIMARY KEY,
    board_id      TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('note', 'image', 'sticker')),

    x             REAL NOT NULL DEFAULT 0,
    y             REAL NOT NULL DEFAULT 0,
    rotation      REAL NOT NULL DEFAULT 0,
    scale         REAL NOT NULL DEFAULT 1,
    z             INTEGER NOT NULL DEFAULT 0,

    -- Intrinsic pixel size of the source image; what is drawn is this times
    -- `scale`. Face boxes are stored against the intrinsic size, so both are
    -- needed to place them.
    width         REAL,
    height        REAL,

    -- Notes.
    text          TEXT,
    font_size     REAL,
    color         TEXT,

    -- Images and stickers.
    r2_key        TEXT,
    original_key  TEXT,
    ocr_text      TEXT,

    -- Snapping. A card dropped on a grid records the cell it landed in; a
    -- sticker dropped on a card records what it is stuck to, so it travels with
    -- it. Both nullable, because most things are simply loose on the board.
    grid_id       TEXT REFERENCES grids(id) ON DELETE SET NULL,
    grid_column   TEXT,
    grid_row      TEXT,
    attached_to   TEXT REFERENCES cards(id) ON DELETE CASCADE,

    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

-- Full-text search over what was typed and what was read out of an image.
-- `card_id` is UNINDEXED: it is carried so a hit resolves back to a card, but
-- nobody searches for a uuid and indexing it would let a stray query match one.
CREATE VIRTUAL TABLE card_search USING fts5(card_id UNINDEXED, body);

-- Kept in step by triggers rather than application code. Several routes write
-- to `cards`, and search that silently drifts from its source is worse than no
-- search at all.
CREATE TRIGGER cards_search_insert AFTER INSERT ON cards BEGIN
    INSERT INTO card_search (card_id, body)
    VALUES (new.id, TRIM(COALESCE(new.text, '') || ' ' || COALESCE(new.ocr_text, '')));
END;

CREATE TRIGGER cards_search_update AFTER UPDATE OF text, ocr_text ON cards BEGIN
    DELETE FROM card_search WHERE card_id = old.id;
    INSERT INTO card_search (card_id, body)
    VALUES (new.id, TRIM(COALESCE(new.text, '') || ' ' || COALESCE(new.ocr_text, '')));
END;

CREATE TRIGGER cards_search_delete AFTER DELETE ON cards BEGIN
    DELETE FROM card_search WHERE card_id = old.id;
END;

-- A named person on a board. Scoped to the board: the same face in two
-- investigations is two people as far as this is concerned.
CREATE TABLE people (
    id          TEXT PRIMARY KEY,
    board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

-- Names are matched case-insensitively when a face is labelled, so the same
-- rule is enforced here. Without it "M. Reyes" and "m. reyes" could become two
-- people who never string together — the exact failure the matching exists to
-- prevent.
CREATE UNIQUE INDEX idx_people_name ON people(board_id, name COLLATE NOCASE);

-- A face found in a card, in that image's intrinsic coordinates. `person_id` is
-- null until somebody names it: detection finds faces, people identify them.
--
-- `embedding` is 128 float32s — 512 bytes — describing what the face LOOKS like,
-- close together for two photographs of the same person and far apart for two
-- people. It is a BLOB in D1 rather than a row in a vector database, and that is
-- a deliberate choice: a board holds tens of faces, not millions, so the whole
-- set fits in one query and the comparison is a dot product per row. Reaching
-- for Vectorize here would add a service that cannot be emulated locally — this
-- repo would stop running from a clean clone — to answer a question a linear
-- scan answers in under a millisecond. See `matchFace` in server/utils/faces.ts.
--
-- Nullable, because a face at the very edge of a photograph can be detected and
-- still not produce a crop the aligner will accept. A face with no embedding is
-- a box you can name by hand; it just cannot be matched automatically.
CREATE TABLE faces (
    id          TEXT PRIMARY KEY,
    card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    person_id   TEXT REFERENCES people(id) ON DELETE SET NULL,
    x           REAL NOT NULL,
    y           REAL NOT NULL,
    w           REAL NOT NULL,
    h           REAL NOT NULL,
    embedding   BLOB,
    created_at  INTEGER NOT NULL
);

-- A string between two cards. Only strings drawn by hand are stored; the ones
-- implied by a shared person are derived when the board is read.
CREATE TABLE links (
    id            TEXT PRIMARY KEY,
    board_id      TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    from_card_id  TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    to_card_id    TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    color         TEXT NOT NULL DEFAULT 'red',
    label         TEXT,
    created_at    INTEGER NOT NULL
);

CREATE INDEX idx_cards_board ON cards(board_id);
CREATE INDEX idx_cards_grid ON cards(grid_id);
CREATE INDEX idx_cards_attached ON cards(attached_to);
CREATE INDEX idx_grids_board ON grids(board_id);
CREATE INDEX idx_faces_card ON faces(card_id);
CREATE INDEX idx_faces_person ON faces(person_id);
CREATE INDEX idx_links_board ON links(board_id);
