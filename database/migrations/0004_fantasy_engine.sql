-- Migration 0004: data-driven fantasy engine + scenario library + gameplay
-- state. Increment 4.
--
-- Design:
--  * Scenario CONTENT is data (scenarios -> scenario_versions -> nodes ->
--    choices -> choice requirements), never hard-coded in application logic.
--  * Scenario VERSIONS are immutable snapshots. A session pins exactly one
--    scenario_version_id; publishing a newer version never mutates a running
--    session. FKs use ON DELETE RESTRICT for anything a session can reference,
--    so content a session depends on cannot be deleted out from under it.
--  * Gameplay state lives on fantasy_sessions (extended below) and advances
--    only server-side, with optimistic concurrency via state_version.
--  * session_actions provides per-(session,user,client_action_id) idempotency.
--
-- Forward-only. Safe, additive. Does not modify released migrations.

-- =========================================================================
-- SCENARIOS (authoring parent) + immutable VERSIONS
-- =========================================================================
CREATE TABLE scenarios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description   TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  category      TEXT NOT NULL DEFAULT 'romance',
  cover_image_url TEXT,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  estimated_minutes INT CHECK (estimated_minutes IS NULL OR estimated_minutes BETWEEN 1 AND 600),
  status        TEXT NOT NULL DEFAULT 'DRAFT'
                CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One scenario per slug (case-insensitive).
CREATE UNIQUE INDEX scenarios_slug_unique ON scenarios (lower(slug));
CREATE INDEX scenarios_status ON scenarios (status);
CREATE TRIGGER scenarios_updated_at BEFORE UPDATE ON scenarios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- An immutable published snapshot of a scenario's content.
CREATE TABLE scenario_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id   uuid NOT NULL REFERENCES scenarios(id) ON DELETE RESTRICT,
  version       INT NOT NULL CHECK (version >= 1),
  status        TEXT NOT NULL DEFAULT 'DRAFT'
                CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  -- The node a new game starts at (resolved after nodes are inserted).
  start_node_id uuid,
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scenario_id, version)
);
CREATE INDEX scenario_versions_scenario ON scenario_versions (scenario_id);
CREATE INDEX scenario_versions_published
  ON scenario_versions (scenario_id) WHERE status = 'PUBLISHED';
CREATE TRIGGER scenario_versions_updated_at BEFORE UPDATE ON scenario_versions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- NODES + CHOICES (the branching graph for a version)
-- =========================================================================
CREATE TABLE scenario_nodes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_version_id uuid NOT NULL REFERENCES scenario_versions(id) ON DELETE RESTRICT,
  node_key            TEXT NOT NULL,
  node_type           TEXT NOT NULL CHECK (node_type IN ('START','NARRATIVE','CHOICE','ENDING')),
  title               TEXT NOT NULL DEFAULT '' CHECK (char_length(title) <= 200),
  content             TEXT NOT NULL DEFAULT '' CHECK (char_length(content) <= 8000),
  sort_order          INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- node_key is unique within a version so content can reference by key.
  UNIQUE (scenario_version_id, node_key)
);
CREATE INDEX scenario_nodes_version ON scenario_nodes (scenario_version_id);

-- Deferred FK: a version's start node must belong to that version.
ALTER TABLE scenario_versions
  ADD CONSTRAINT scenario_versions_start_node_fk
  FOREIGN KEY (start_node_id) REFERENCES scenario_nodes(id) ON DELETE RESTRICT;

CREATE TABLE scenario_choices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id       uuid NOT NULL REFERENCES scenario_nodes(id) ON DELETE CASCADE,
  choice_key    TEXT NOT NULL,
  label         TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 300),
  description   TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  -- The server-resolved destination. The client NEVER supplies a next node.
  next_node_id  uuid NOT NULL REFERENCES scenario_nodes(id) ON DELETE RESTRICT,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (node_id, choice_key)
);
CREATE INDEX scenario_choices_node ON scenario_choices (node_id);

-- A choice may require one or more mutually-agreed consent categories.
CREATE TABLE scenario_choice_requirements (
  choice_id        uuid NOT NULL REFERENCES scenario_choices(id) ON DELETE CASCADE,
  consent_category TEXT NOT NULL,
  PRIMARY KEY (choice_id, consent_category)
);

-- =========================================================================
-- GAMEPLAY STATE on fantasy_sessions (additive columns).
-- =========================================================================
ALTER TABLE fantasy_sessions
  ADD COLUMN scenario_version_id uuid REFERENCES scenario_versions(id) ON DELETE RESTRICT,
  ADD COLUMN current_node_id     uuid REFERENCES scenario_nodes(id) ON DELETE RESTRICT,
  ADD COLUMN turn_number         INT NOT NULL DEFAULT 0,
  -- Optimistic-concurrency token: every authoritative gameplay transition
  -- bumps this; a stale client update affects 0 rows -> GAME_STATE_CONFLICT.
  ADD COLUMN state_version       INT NOT NULL DEFAULT 0,
  ADD COLUMN started_at          TIMESTAMPTZ,
  ADD COLUMN completed_at        TIMESTAMPTZ;

CREATE INDEX fantasy_sessions_scenario_version
  ON fantasy_sessions (scenario_version_id);
CREATE INDEX fantasy_sessions_current_node
  ON fantasy_sessions (current_node_id);

-- =========================================================================
-- SESSION ACTIONS — idempotency ledger for gameplay actions.
-- =========================================================================
CREATE TABLE session_actions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES fantasy_sessions(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_action_id uuid NOT NULL,
  action_type      TEXT NOT NULL,
  -- The resulting node after the action, so a retried action can return the
  -- same authoritative result without re-advancing the scenario.
  result_node_id   uuid REFERENCES scenario_nodes(id) ON DELETE SET NULL,
  result_turn      INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One action per (session, user, client_action_id) => idempotent retries.
  UNIQUE (session_id, user_id, client_action_id)
);
CREATE INDEX session_actions_session ON session_actions (session_id);
