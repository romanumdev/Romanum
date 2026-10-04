-- OAuth grants coexist with legacy keys. No existing credential is replaced or deleted.
CREATE TABLE linked_game_oauth (
  game_id uuid PRIMARY KEY REFERENCES linked_games(id) ON DELETE CASCADE,
  key_version smallint NOT NULL CHECK (key_version > 0),
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 65536),
  tag bytea NOT NULL CHECK (octet_length(tag) = 16),
  subject text NOT NULL CHECK (subject ~ '^[1-9][0-9]{0,14}$'),
  expires_at timestamptz NOT NULL,
  reconnect_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
