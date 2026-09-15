export const DEFAULT_WORKSPACE_ID = 'local';

function hasColumn(database, tableName, columnName) {
  return database.prepare(`PRAGMA table_info(${tableName})`).all()
    .some((column) => column.name === columnName);
}

function addColumn(database, tableName, columnName, definition) {
  if (!hasColumn(database, tableName, columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

const migrations = [
  {
    version: 1,
    name: 'v1-baseline',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          paired_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          revoked_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS pairing_codes (
          code_hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          used_at INTEGER,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS posts (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          source_url TEXT NOT NULL DEFAULT '',
          tags_json TEXT NOT NULL DEFAULT '[]',
          created_by_device TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(created_by_device) REFERENCES devices(id)
        );

        CREATE TABLE IF NOT EXISTS behavior_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          device_id TEXT,
          event_name TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          FOREIGN KEY(device_id) REFERENCES devices(id)
        );

        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          body TEXT NOT NULL,
          ai_reply TEXT NOT NULL DEFAULT '',
          want_ai INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'inbox',
          knowledge_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS knowledge_items (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          source TEXT NOT NULL,
          source_note_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_devices_active ON devices(revoked_at, last_seen_at DESC);
        CREATE INDEX IF NOT EXISTS idx_behavior_created_at ON behavior_events(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_knowledge_created_at ON knowledge_items(created_at DESC);
      `);
    },
  },
  {
    version: 2,
    name: 'workspace-scope',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      const now = Date.now();
      database.prepare(`INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at)
        VALUES (?, '我的 AI Center', ?, ?)`).run(DEFAULT_WORKSPACE_ID, now, now);

      addColumn(database, 'devices', 'workspace_id', `TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'`);
      addColumn(database, 'posts', 'workspace_id', `TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'`);
      addColumn(database, 'behavior_events', 'workspace_id', `TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'`);
      addColumn(database, 'notes', 'workspace_id', `TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'`);
      addColumn(database, 'knowledge_items', 'workspace_id', `TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'`);

      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_posts_workspace_created ON posts(workspace_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notes_workspace_status ON notes(workspace_id, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_knowledge_workspace_created ON knowledge_items(workspace_id, created_at DESC);
      `);
    },
  },
  {
    version: 3,
    name: 'runtime-jobs-and-events',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          input_json TEXT NOT NULL DEFAULT '{}',
          output_json TEXT,
          error_json TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          available_at INTEGER NOT NULL,
          locked_by TEXT,
          locked_at INTEGER,
          started_at INTEGER,
          completed_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );

        CREATE TABLE IF NOT EXISTS outbox_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL,
          event_name TEXT NOT NULL,
          aggregate_type TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );

        CREATE TABLE IF NOT EXISTS provider_health (
          workspace_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          status TEXT NOT NULL,
          message TEXT NOT NULL DEFAULT '',
          last_success_at INTEGER,
          last_failure_at INTEGER,
          checked_at INTEGER NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY(workspace_id, provider_id),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, available_at, priority DESC, created_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_workspace_created ON jobs(workspace_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_outbox_workspace_id ON outbox_events(workspace_id, id);
      `);
    },
  },
  {
    version: 4,
    name: 'domain-foundation',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS source_accounts (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          external_id TEXT NOT NULL,
          handle TEXT NOT NULL DEFAULT '',
          display_name TEXT NOT NULL DEFAULT '',
          profile_url TEXT NOT NULL DEFAULT '',
          auth_mode TEXT NOT NULL DEFAULT 'public',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(workspace_id, provider, external_id),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );

        CREATE TABLE IF NOT EXISTS subscriptions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          source_account_id TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          priority INTEGER NOT NULL DEFAULT 0,
          refresh_interval_minutes INTEGER NOT NULL DEFAULT 30,
          notification_policy TEXT NOT NULL DEFAULT 'none',
          last_sync_at INTEGER,
          next_sync_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(workspace_id, source_account_id),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY(source_account_id) REFERENCES source_accounts(id)
        );

        CREATE TABLE IF NOT EXISTS captures (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          external_id TEXT NOT NULL,
          source_account_id TEXT,
          source_url TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          content_hash TEXT NOT NULL,
          raw_artifact_path TEXT,
          status TEXT NOT NULL DEFAULT 'captured',
          published_at INTEGER,
          captured_at INTEGER NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          UNIQUE(workspace_id, provider, external_id),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY(source_account_id) REFERENCES source_accounts(id)
        );

        CREATE TABLE IF NOT EXISTS content_items (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          capture_id TEXT UNIQUE,
          origin_type TEXT NOT NULL,
          content_type TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          source_url TEXT NOT NULL DEFAULT '',
          author_name TEXT NOT NULL DEFAULT '',
          published_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY(capture_id) REFERENCES captures(id)
        );

        CREATE TABLE IF NOT EXISTS user_item_states (
          workspace_id TEXT NOT NULL,
          content_item_id TEXT NOT NULL,
          is_read INTEGER NOT NULL DEFAULT 0,
          is_saved INTEGER NOT NULL DEFAULT 0,
          is_hidden INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(workspace_id, content_item_id),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY(content_item_id) REFERENCES content_items(id)
        );

        CREATE TABLE IF NOT EXISTS instruments (
          id TEXT PRIMARY KEY,
          canonical_symbol TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          asset_class TEXT NOT NULL,
          market TEXT NOT NULL,
          exchange_code TEXT NOT NULL DEFAULT '',
          currency TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS watchlists (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );

        CREATE TABLE IF NOT EXISTS watchlist_items (
          watchlist_id TEXT NOT NULL,
          instrument_id TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(watchlist_id, instrument_id),
          FOREIGN KEY(watchlist_id) REFERENCES watchlists(id),
          FOREIGN KEY(instrument_id) REFERENCES instruments(id)
        );

        CREATE TABLE IF NOT EXISTS portfolios (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          market_scope TEXT NOT NULL DEFAULT 'mixed',
          base_currency TEXT NOT NULL,
          initial_capital REAL NOT NULL DEFAULT 0,
          archived_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );

        CREATE TABLE IF NOT EXISTS transactions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          portfolio_id TEXT NOT NULL,
          instrument_id TEXT,
          transaction_type TEXT NOT NULL,
          quantity REAL NOT NULL DEFAULT 0,
          price REAL NOT NULL DEFAULT 0,
          currency TEXT NOT NULL,
          fees REAL NOT NULL DEFAULT 0,
          note TEXT NOT NULL DEFAULT '',
          occurred_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY(portfolio_id) REFERENCES portfolios(id),
          FOREIGN KEY(instrument_id) REFERENCES instruments(id)
        );

        CREATE TABLE IF NOT EXISTS quote_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          instrument_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          price REAL NOT NULL,
          previous_close REAL,
          currency TEXT NOT NULL,
          quality TEXT NOT NULL DEFAULT 'unknown',
          market_time INTEGER,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(instrument_id) REFERENCES instruments(id)
        );

        CREATE TABLE IF NOT EXISTS position_snapshots (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          portfolio_id TEXT NOT NULL,
          instrument_id TEXT NOT NULL,
          snapshot_date TEXT NOT NULL,
          quantity REAL NOT NULL,
          cost_basis REAL NOT NULL,
          market_value REAL NOT NULL,
          daily_pnl REAL NOT NULL,
          total_pnl REAL NOT NULL,
          currency TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(portfolio_id, instrument_id, snapshot_date),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY(portfolio_id) REFERENCES portfolios(id),
          FOREIGN KEY(instrument_id) REFERENCES instruments(id)
        );

        CREATE TABLE IF NOT EXISTS fx_rates (
          base_currency TEXT NOT NULL,
          quote_currency TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          rate REAL NOT NULL,
          as_of INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(base_currency, quote_currency, provider_id, as_of)
        );

        CREATE TABLE IF NOT EXISTS ai_runs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          task_type TEXT NOT NULL,
          status TEXT NOT NULL,
          provider_id TEXT NOT NULL DEFAULT '',
          model_id TEXT NOT NULL DEFAULT '',
          input_hash TEXT NOT NULL DEFAULT '',
          output_text TEXT NOT NULL DEFAULT '',
          output_json TEXT,
          error_json TEXT,
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );

        CREATE TABLE IF NOT EXISTS knowledge_links (
          knowledge_id TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          relation_type TEXT NOT NULL DEFAULT 'derived_from',
          created_at INTEGER NOT NULL,
          PRIMARY KEY(knowledge_id, source_type, source_id, relation_type),
          FOREIGN KEY(knowledge_id) REFERENCES knowledge_items(id)
        );

        CREATE TABLE IF NOT EXISTS daily_reports (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          report_date TEXT NOT NULL,
          status TEXT NOT NULL,
          content_json TEXT NOT NULL DEFAULT '{}',
          source_refs_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(workspace_id, report_date),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );

        CREATE INDEX IF NOT EXISTS idx_subscriptions_due ON subscriptions(enabled, next_sync_at);
        CREATE INDEX IF NOT EXISTS idx_captures_published ON captures(workspace_id, published_at DESC);
        CREATE INDEX IF NOT EXISTS idx_content_feed ON content_items(workspace_id, published_at DESC, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_transactions_portfolio_time ON transactions(portfolio_id, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_quotes_instrument_time ON quote_snapshots(instrument_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_runs_source ON ai_runs(workspace_id, source_type, source_id, created_at DESC);
      `);
    },
  },
];

export function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all()
    .map((row) => row.version));

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.exec('BEGIN IMMEDIATE');
    try {
      migration.up(database);
      database.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, Date.now());
      database.pragma(`user_version = ${migration.version}`);
      database.exec('COMMIT');
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  return migrations.at(-1)?.version || 0;
}

export function latestSchemaVersion() {
  return migrations.at(-1)?.version || 0;
}
