-- Private development tasks retain the prepared brief and its evidence snapshot.
-- Optional project association cannot cross owners; guests can keep standalone tasks.
CREATE TABLE analytics_experiments (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  project_id uuid,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  brief jsonb NOT NULL CHECK (jsonb_typeof(brief) = 'object'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  intended_metric text NOT NULL CHECK (intended_metric IN ('public_playing','retention','revenue')),
  universe_id bigint CHECK (universe_id > 0),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','released','archived')),
  release_date date,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_id),
  FOREIGN KEY (project_id, owner_id) REFERENCES creative_projects(id, owner_id) ON DELETE CASCADE
);
CREATE INDEX analytics_experiments_owner_updated ON analytics_experiments(owner_id, updated_at DESC, id);
CREATE TRIGGER account_closure_guard BEFORE INSERT OR UPDATE ON analytics_experiments
  FOR EACH ROW EXECUTE FUNCTION romanum_reject_closed_owner();
