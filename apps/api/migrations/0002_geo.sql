CREATE TABLE postal_codes (
  country TEXT NOT NULL, code TEXT NOT NULL, place_name TEXT NOT NULL, admin1 TEXT,
  lat REAL NOT NULL, lng REAL NOT NULL, PRIMARY KEY (country, code));
