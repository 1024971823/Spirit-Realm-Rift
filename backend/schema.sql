CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  banned boolean NOT NULL DEFAULT false,
  muted_until timestamptz,
  profile jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  digest text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions(account_id);
CREATE TABLE IF NOT EXISTS account_tokens (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('verify','reset')),
  digest text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, kind)
);
CREATE TABLE IF NOT EXISTS game_owners (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','finished','cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS matches_active_idx ON matches(owner_id) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS match_players (
  match_id uuid NOT NULL REFERENCES matches(id),
  player_id uuid NOT NULL REFERENCES accounts(id),
  summary jsonb,
  PRIMARY KEY (match_id, player_id)
);
CREATE INDEX IF NOT EXISTS match_players_player_idx ON match_players(player_id, match_id);
CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY,
  room_id text NOT NULL,
  player_id uuid NOT NULL REFERENCES accounts(id),
  callsign text NOT NULL,
  body text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_sent_idx ON chat_messages(sent_at);
CREATE TABLE IF NOT EXISTS chat_blocks (
  player_id uuid NOT NULL REFERENCES accounts(id),
  blocked_id uuid NOT NULL REFERENCES accounts(id),
  PRIMARY KEY (player_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS chat_reports (
  message_id uuid NOT NULL REFERENCES chat_messages(id),
  reporter_id uuid NOT NULL REFERENCES accounts(id),
  reason text NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY (message_id, reporter_id)
);
CREATE TABLE IF NOT EXISTS moderation_actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES chat_messages(id),
  actor_id uuid NOT NULL REFERENCES accounts(id),
  target_id uuid NOT NULL REFERENCES accounts(id),
  action text NOT NULL CHECK (action IN ('dismiss','mute','ban')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
