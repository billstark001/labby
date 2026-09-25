CREATE TABLE scheduler_dispatches (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running'
);
CREATE INDEX scheduler_dispatches_claimed_at_idx ON scheduler_dispatches (claimed_at);
