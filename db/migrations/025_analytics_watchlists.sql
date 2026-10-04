-- Private saved public games. Public collection never exposes who saved them.
CREATE TABLE analytics_watchlists (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  universe_id bigint NOT NULL REFERENCES history_games(universe_id),
  peer_ids bigint[] NOT NULL DEFAULT '{}' CHECK (cardinality(peer_ids) <= 5),
  enabled boolean NOT NULL DEFAULT true,
  direction text NOT NULL DEFAULT 'either' CHECK (direction IN ('up','down','either')),
  threshold_percent integer NOT NULL DEFAULT 20 CHECK (threshold_percent BETWEEN 5 AND 500),
  minimum_players integer NOT NULL DEFAULT 25 CHECK (minimum_players BETWEEN 1 AND 1000000),
  window_minutes integer NOT NULL DEFAULT 30 CHECK (window_minutes IN (30,60)),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,owner_id),
  UNIQUE (owner_id,universe_id)
);
CREATE INDEX analytics_watchlists_owner ON analytics_watchlists(owner_id,updated_at DESC);
CREATE TABLE analytics_watchlist_state (
  watchlist_id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  revision integer NOT NULL,
  latched boolean NOT NULL DEFAULT false,
  evaluated_slot timestamptz,
  coverage text NOT NULL DEFAULT 'waiting' CHECK (coverage IN ('waiting','ready','unavailable')),
  detail text NOT NULL DEFAULT 'Waiting for matched public observations.',
  FOREIGN KEY(watchlist_id,owner_id) REFERENCES analytics_watchlists(id,owner_id) ON DELETE CASCADE
);
CREATE TABLE analytics_notifications (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  watchlist_id uuid NOT NULL,
  dedupe_key text NOT NULL UNIQUE CHECK (length(dedupe_key) <= 200),
  observed_at timestamptz NOT NULL,
  title text NOT NULL CHECK (length(title) <= 200),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(watchlist_id,owner_id) REFERENCES analytics_watchlists(id,owner_id) ON DELETE CASCADE
);
CREATE INDEX analytics_notifications_owner ON analytics_notifications(owner_id,created_at DESC);
CREATE INDEX history_targets_game_run ON history_targets(universe_id,run_id);
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON analytics_watchlists
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON analytics_watchlist_state
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON analytics_notifications
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
