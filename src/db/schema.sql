-- PremiumKits Panel Schema v2.0

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT UNIQUE NOT NULL,
  username     TEXT UNIQUE NOT NULL,
  password     TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS servers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  api_key      TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  online       BOOLEAN DEFAULT false,
  last_ping    TIMESTAMPTZ,
  config       JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Kits: no mandatory world, fully flexible access rules
CREATE TABLE IF NOT EXISTS kits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id    UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kit_id       TEXT NOT NULL,          -- unique string id e.g. "kit_vip_sword"
  name         TEXT NOT NULL,          -- display name
  description  TEXT,
  enabled      BOOLEAN DEFAULT true,
  icon         TEXT DEFAULT 'CHEST',   -- material for panel icon
  items        JSONB DEFAULT '{}',     -- slot -> {type, amount, meta}
  -- Access rules: who can receive this kit
  access       JSONB DEFAULT '{"type":"EVERYONE"}',
  -- {type: "EVERYONE"|"GROUP"|"PERMISSION"|"PLAYER"|"WORLD",
  --  group: "vip", permission: "premiumkits.vip", player: "uuid",
  --  worlds: ["ffa_sword","lobby"]}
  -- Conditions: when/how the kit can be received
  conditions   JSONB DEFAULT '{}',
  -- {cooldownSeconds, minLevel, minMoney, cost, oneTime, worldGuardRegion,
  --  requiresPreviewAccept, placeholderCheck: {placeholder,operator,value}}
  -- Actions: what happens on receive
  actions      JSONB DEFAULT '{}',
  -- {onReceiveCommand, broadcast, sound, soundVolume, soundPitch,
  --  particle, particleCount, particleColor, customMessage}
  priority     INT DEFAULT 0,
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(server_id, kit_id)
);

CREATE TABLE IF NOT EXISTS kit_gives (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id    UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kit_id       TEXT NOT NULL,
  player_uuid  TEXT NOT NULL,
  player_name  TEXT,
  given_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_cooldowns (
  server_id    UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kit_id       TEXT NOT NULL,
  player_uuid  TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (server_id, kit_id, player_uuid)
);

CREATE TABLE IF NOT EXISTS team_members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id    UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT DEFAULT 'viewer',  -- admin | editor | viewer
  invited_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(server_id, user_id)
);

CREATE TABLE IF NOT EXISTS two_factor_auth (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret       TEXT NOT NULL,
  enabled      BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token        TEXT UNIQUE NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kits_server   ON kits(server_id, enabled);
CREATE INDEX IF NOT EXISTS idx_gives_server  ON kit_gives(server_id, kit_id);
CREATE INDEX IF NOT EXISTS idx_gives_player  ON kit_gives(server_id, player_uuid);
CREATE INDEX IF NOT EXISTS idx_cooldowns     ON player_cooldowns(server_id, player_uuid);
