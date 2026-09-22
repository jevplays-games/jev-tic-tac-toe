PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, discord_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL, avatar_hash TEXT,
  moderation_state TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), csrf TEXT NOT NULL,
  oauth_state_hash TEXT, oauth_expires INTEGER, pending_launch TEXT, context_json TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS launches (
  token_hash TEXT PRIMARY KEY, interaction_id TEXT NOT NULL UNIQUE,
  discord_id TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL, redeem_expires INTEGER NOT NULL,
  redeemed_session TEXT, redeemed_at INTEGER, context_expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY, owner_session TEXT NOT NULL, user_id TEXT REFERENCES users(id),
  create_key TEXT NOT NULL, create_fingerprint TEXT NOT NULL,
  config_hash TEXT NOT NULL, difficulty TEXT NOT NULL, model_id TEXT NOT NULL,
  human_mark TEXT NOT NULL CHECK(human_mark IN ('X','O')), guild_id TEXT, channel_id TEXT,
  revision INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('human_turn','jev_pending','complete','void')),
  ranked_started INTEGER NOT NULL CHECK(ranked_started IN (0,1)), eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),
  outcome TEXT CHECK(outcome IN ('win','draw','loss')), termination TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, finished_at INTEGER,
  doc TEXT NOT NULL CHECK(json_valid(doc)), UNIQUE(owner_session,create_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_ranked ON matches(user_id)
  WHERE ranked_started=1 AND status IN ('human_turn','jev_pending');
CREATE INDEX IF NOT EXISTS world_results ON matches(config_hash,human_mark,finished_at,user_id) WHERE eligible=1 AND status='complete';
CREATE INDEX IF NOT EXISTS server_results ON matches(guild_id,config_hash,human_mark,finished_at,user_id) WHERE eligible=1 AND status='complete';
CREATE INDEX IF NOT EXISTS channel_results ON matches(channel_id,config_hash,human_mark,finished_at,user_id) WHERE eligible=1 AND status='complete';
CREATE INDEX IF NOT EXISTS account_history ON matches(user_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS guest_history ON matches(owner_session,created_at DESC,id);
CREATE INDEX IF NOT EXISTS match_expiry ON matches(status,expires_at);
CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS quotas (id TEXT PRIMARY KEY,n INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS quota_expiry ON quotas(expires_at);
-- Coarse operational counters contain no user, IP, request-body or query-string data.
CREATE TABLE IF NOT EXISTS operational_counters (
  day TEXT NOT NULL, route TEXT NOT NULL, method TEXT NOT NULL,
  status INTEGER NOT NULL, code TEXT NOT NULL, latency_bucket TEXT NOT NULL,
  n INTEGER NOT NULL, sum_ms REAL NOT NULL, max_ms REAL NOT NULL,
  PRIMARY KEY(day,route,method,status,code,latency_bucket)
);
