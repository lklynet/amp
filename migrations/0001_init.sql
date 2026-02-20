CREATE TABLE artist (
  mbid TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE artist_credit (
  credit_id INTEGER PRIMARY KEY
);

CREATE TABLE artist_credit_name (
  credit_id INTEGER NOT NULL,
  artist_mbid TEXT NOT NULL,
  name TEXT NOT NULL,
  join_phrase TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (credit_id, position)
);

CREATE TABLE release_group (
  mbid TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist_credit_id INTEGER NOT NULL,
  canonical_release_mbid TEXT,
  caa_url TEXT NOT NULL,
  canonical_release_caa_url TEXT
);

CREATE TABLE release (
  mbid TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  release_group_mbid TEXT NOT NULL,
  artist_credit_id INTEGER NOT NULL,
  caa_url TEXT NOT NULL
);

CREATE TABLE release_group_release (
  release_group_mbid TEXT NOT NULL,
  release_mbid TEXT NOT NULL,
  PRIMARY KEY (release_group_mbid, release_mbid)
);

CREATE INDEX idx_artist_credit_name_artist_mbid ON artist_credit_name(artist_mbid);
CREATE INDEX idx_release_group_artist_credit_id ON release_group(artist_credit_id);
CREATE INDEX idx_release_artist_credit_id ON release(artist_credit_id);
CREATE INDEX idx_release_release_group_mbid ON release(release_group_mbid);
