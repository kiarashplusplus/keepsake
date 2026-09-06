CREATE VIRTUAL TABLE listings_fts USING fts5(title, story, content='listings', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2');

CREATE TRIGGER listings_fts_ai AFTER INSERT ON listings BEGIN
  INSERT INTO listings_fts(rowid, title, story) VALUES (new.rowid, new.title, new.story);
END;

CREATE TRIGGER listings_fts_ad AFTER DELETE ON listings BEGIN
  INSERT INTO listings_fts(listings_fts, rowid, title, story) VALUES('delete', old.rowid, old.title, old.story);
END;

CREATE TRIGGER listings_fts_au AFTER UPDATE OF title, story ON listings BEGIN
  INSERT INTO listings_fts(listings_fts, rowid, title, story) VALUES('delete', old.rowid, old.title, old.story);
  INSERT INTO listings_fts(rowid, title, story) VALUES (new.rowid, new.title, new.story);
END;
