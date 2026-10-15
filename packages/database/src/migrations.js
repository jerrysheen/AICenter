import { randomUUID } from 'node:crypto';
import { computeFeedIdentityHash } from '../../domain/src/feed-identity.js';
import { retireSupersededHardwareQuotes } from './hardware-price-current.js';
import { seedWorkspaceTaxonomy } from './taxonomy-seed.js';

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
  {
    version: 5,
    name: 'note-pin',
    up(database) {
      addColumn(database, 'notes', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 6,
    name: 'modular-domain-contracts',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS collector_nodes (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'offline',
          capabilities_json TEXT NOT NULL DEFAULT '[]',
          last_seen_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );

        CREATE TABLE IF NOT EXISTS credential_refs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          collector_node_id TEXT,
          provider_id TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT '',
          ref_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(workspace_id, ref_key),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY(collector_node_id) REFERENCES collector_nodes(id)
        );

        CREATE TABLE IF NOT EXISTS source_account_bindings (
          source_account_id TEXT PRIMARY KEY,
          collector_node_id TEXT,
          credential_ref_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(source_account_id) REFERENCES source_accounts(id),
          FOREIGN KEY(collector_node_id) REFERENCES collector_nodes(id),
          FOREIGN KEY(credential_ref_id) REFERENCES credential_refs(id)
        );

        CREATE TABLE IF NOT EXISTS instrument_aliases (
          instrument_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          provider_symbol TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(provider_id, provider_symbol),
          FOREIGN KEY(instrument_id) REFERENCES instruments(id)
        );

        CREATE TABLE IF NOT EXISTS job_attempts (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          worker_id TEXT NOT NULL,
          status TEXT NOT NULL,
          error_json TEXT,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          UNIQUE(job_id, attempt_number),
          FOREIGN KEY(job_id) REFERENCES jobs(id)
        );

        CREATE TABLE IF NOT EXISTS knowledge_revisions (
          id TEXT PRIMARY KEY,
          knowledge_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          created_by_type TEXT NOT NULL,
          created_by_id TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(knowledge_id, revision),
          FOREIGN KEY(knowledge_id) REFERENCES knowledge_items(id)
        );

        CREATE TABLE IF NOT EXISTS knowledge_chunks (
          id TEXT PRIMARY KEY,
          knowledge_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL,
          body TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          UNIQUE(knowledge_id, revision, chunk_index),
          FOREIGN KEY(knowledge_id) REFERENCES knowledge_items(id)
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
          knowledge_id UNINDEXED,
          revision UNINDEXED,
          title,
          body,
          tokenize = 'trigram'
        );

        CREATE INDEX IF NOT EXISTS idx_collector_nodes_workspace ON collector_nodes(workspace_id, status);
        CREATE INDEX IF NOT EXISTS idx_credentials_node ON credential_refs(collector_node_id, provider_id);
        CREATE INDEX IF NOT EXISTS idx_aliases_instrument ON instrument_aliases(instrument_id);
        CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts(job_id, attempt_number DESC);
        CREATE INDEX IF NOT EXISTS idx_knowledge_revisions_document ON knowledge_revisions(knowledge_id, revision DESC);
        CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document ON knowledge_chunks(knowledge_id, revision, chunk_index);
      `);

      addColumn(database, 'instruments', 'symbol', "TEXT NOT NULL DEFAULT ''");
      addColumn(database, 'portfolios', 'initial_capital_decimal', "TEXT NOT NULL DEFAULT '0'");
      addColumn(database, 'transactions', 'quantity_decimal', "TEXT NOT NULL DEFAULT '0'");
      addColumn(database, 'transactions', 'price_decimal', "TEXT NOT NULL DEFAULT '0'");
      addColumn(database, 'transactions', 'cash_amount_decimal', "TEXT NOT NULL DEFAULT '0'");
      addColumn(database, 'transactions', 'fees_decimal', "TEXT NOT NULL DEFAULT '0'");
      addColumn(database, 'quote_snapshots', 'price_decimal', "TEXT NOT NULL DEFAULT '0'");
      addColumn(database, 'quote_snapshots', 'previous_close_decimal', 'TEXT');
      addColumn(database, 'quote_snapshots', 'session', "TEXT NOT NULL DEFAULT 'unknown'");
      addColumn(database, 'position_snapshots', 'quantity_decimal', "TEXT NOT NULL DEFAULT '0'");
      addColumn(database, 'position_snapshots', 'cost_basis_decimal', "TEXT NOT NULL DEFAULT '0'");
      addColumn(database, 'position_snapshots', 'market_value_decimal', "TEXT NOT NULL DEFAULT '0'");
      addColumn(database, 'position_snapshots', 'daily_pnl_decimal', "TEXT NOT NULL DEFAULT '0'");
      addColumn(database, 'position_snapshots', 'total_pnl_decimal', "TEXT NOT NULL DEFAULT '0'");
      addColumn(database, 'fx_rates', 'rate_decimal', "TEXT NOT NULL DEFAULT '0'");
      addColumn(database, 'knowledge_items', 'status', "TEXT NOT NULL DEFAULT 'active'");
      addColumn(database, 'knowledge_items', 'current_revision', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(database, 'knowledge_items', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'");
      addColumn(database, 'outbox_events', 'schema_version', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(database, 'outbox_events', 'correlation_id', 'TEXT');
      addColumn(database, 'outbox_events', 'causation_id', 'TEXT');
      addColumn(database, 'outbox_events', 'occurred_at', 'INTEGER');

      database.exec(`
        UPDATE instruments SET symbol = canonical_symbol WHERE symbol = '';
        UPDATE portfolios SET initial_capital_decimal = CAST(initial_capital AS TEXT)
          WHERE initial_capital_decimal = '0' AND initial_capital != 0;
        UPDATE transactions SET
          quantity_decimal = CAST(quantity AS TEXT),
          price_decimal = CAST(price AS TEXT),
          fees_decimal = CAST(fees AS TEXT)
          WHERE quantity_decimal = '0' AND price_decimal = '0' AND fees_decimal = '0';
        UPDATE quote_snapshots SET
          price_decimal = CAST(price AS TEXT),
          previous_close_decimal = CASE WHEN previous_close IS NULL THEN NULL ELSE CAST(previous_close AS TEXT) END
          WHERE price_decimal = '0';
        UPDATE position_snapshots SET
          quantity_decimal = CAST(quantity AS TEXT),
          cost_basis_decimal = CAST(cost_basis AS TEXT),
          market_value_decimal = CAST(market_value AS TEXT),
          daily_pnl_decimal = CAST(daily_pnl AS TEXT),
          total_pnl_decimal = CAST(total_pnl AS TEXT)
          WHERE quantity_decimal = '0' AND market_value_decimal = '0';
        UPDATE fx_rates SET rate_decimal = CAST(rate AS TEXT) WHERE rate_decimal = '0';
        UPDATE outbox_events SET occurred_at = created_at WHERE occurred_at IS NULL;

        INSERT OR IGNORE INTO knowledge_revisions
          (id, knowledge_id, revision, title, body, created_by_type, created_by_id, created_at)
        SELECT 'legacy:' || id, id, 1, title, body, 'import', source_note_id, created_at
        FROM knowledge_items;

        INSERT INTO knowledge_fts (knowledge_id, revision, title, body)
        SELECT k.id, 1, k.title, k.body
        FROM knowledge_items k
        WHERE NOT EXISTS (
          SELECT 1 FROM knowledge_fts f WHERE f.knowledge_id = k.id AND f.revision = 1
        );
      `);
    },
  },
  {
    version: 7,
    name: 'manual-holding-lots',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS holding_lots (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          portfolio_id TEXT NOT NULL,
          instrument_id TEXT NOT NULL,
          board TEXT NOT NULL,
          quantity_decimal TEXT NOT NULL,
          cost_price_decimal TEXT NOT NULL,
          listing_currency TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          archived_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY(portfolio_id) REFERENCES portfolios(id),
          FOREIGN KEY(instrument_id) REFERENCES instruments(id)
        );
        CREATE TABLE IF NOT EXISTS portfolio_cash (
          portfolio_id TEXT NOT NULL,
          currency TEXT NOT NULL,
          amount_decimal TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(portfolio_id, currency),
          FOREIGN KEY(portfolio_id) REFERENCES portfolios(id)
        );
        CREATE INDEX IF NOT EXISTS idx_holding_lots_portfolio ON holding_lots(portfolio_id, archived_at);
      `);
    },
  },
  {
    version: 8,
    name: 'public-gateway-pairing',
    up(database) {
      addColumn(database, 'pairing_codes', 'public_secret_hash', 'TEXT');
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pairing_public_secret
          ON pairing_codes(public_secret_hash)
          WHERE public_secret_hash IS NOT NULL;
      `);
    },
  },
  {
    version: 9,
    name: 'holding-lot-opened-at',
    up(database) {
      addColumn(database, 'holding_lots', 'opened_at', 'INTEGER');
    },
  },
  {
    version: 10,
    name: 'ai-run-context-refs',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS ai_run_context_refs (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          revision INTEGER,
          as_of INTEGER,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(run_id) REFERENCES ai_runs(id),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_run_context_refs_run
          ON ai_run_context_refs(run_id, created_at ASC);
      `);
    },
  },
  {
    version: 11,
    name: 'feed-item-translations',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS feed_item_translations (
          workspace_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          target_lang TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          translated_text TEXT NOT NULL,
          engine TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(workspace_id, item_id, target_lang),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );
        CREATE INDEX IF NOT EXISTS idx_feed_item_translations_hash
          ON feed_item_translations(workspace_id, source_hash, target_lang);
      `);
    },
  },
  {
    version: 12,
    name: 'ai-sessions',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS ai_sessions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          preview TEXT NOT NULL DEFAULT '',
          source_type TEXT NOT NULL DEFAULT '',
          source_id TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_sessions_workspace
          ON ai_sessions(workspace_id, updated_at DESC, id DESC);
      `);
      addColumn(database, 'ai_runs', 'session_id', "TEXT NOT NULL DEFAULT ''");
      addColumn(database, 'ai_runs', 'input_text', "TEXT NOT NULL DEFAULT ''");
      database.exec(`CREATE INDEX IF NOT EXISTS idx_ai_runs_session ON ai_runs(session_id, created_at ASC)`);

      const runs = database.prepare(`SELECT * FROM ai_runs WHERE session_id = '' ORDER BY created_at ASC`).all();
      const inspirationSessions = new Map();
      const insertSession = database.prepare(`INSERT INTO ai_sessions
        (id, workspace_id, kind, title, preview, source_type, source_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const attachRun = database.prepare('UPDATE ai_runs SET session_id = ? WHERE id = ?');
      for (const run of runs) {
        const kind = run.source_type === 'inspiration' || run.task_type === 'idea-sketch'
          ? 'inspiration' : 'question-answer';
        let sessionId = '';
        if (kind === 'inspiration' && run.source_id) {
          sessionId = inspirationSessions.get(`${run.workspace_id}:${run.source_id}`) || '';
        }
        if (!sessionId) {
          sessionId = randomUUID();
          const titleSource = String(run.input_text || run.output_text || 'AI 记录').replace(/\s+/g, ' ').trim();
          const title = titleSource ? titleSource.slice(0, 36) : 'AI 记录';
          const preview = String(run.output_text || run.input_text || '').replace(/\s+/g, ' ').trim().slice(0, 180);
          insertSession.run(
            sessionId, run.workspace_id, kind, title, preview,
            run.source_type || '', run.source_id || '', run.created_at, run.completed_at || run.created_at,
          );
          if (kind === 'inspiration' && run.source_id) {
            inspirationSessions.set(`${run.workspace_id}:${run.source_id}`, sessionId);
          }
        }
        attachRun.run(sessionId, run.id);
      }
    },
  },
  {
    version: 13,
    name: 'knowledge-revision-search-repair',
    up: backfillKnowledgeRevisionIndex,
  },
  {
    version: 14,
    name: 'ai-run-question-backfill',
    up: backfillAiRunQuestions,
  },
  {
    version: 15,
    name: 'selected-context-refs',
    up(database) {
      addColumn(database, 'ai_run_context_refs', 'origin', `TEXT NOT NULL DEFAULT 'tool'`);
      addColumn(database, 'ai_run_context_refs', 'label', `TEXT NOT NULL DEFAULT ''`);
      addColumn(database, 'notes', 'source_type', `TEXT NOT NULL DEFAULT ''`);
      addColumn(database, 'notes', 'source_id', `TEXT NOT NULL DEFAULT ''`);
    },
  },
  {
    version: 16,
    name: 'knowledge-taxonomy-structure',
    up(database) {
      addColumn(database, 'notes', 'title', `TEXT NOT NULL DEFAULT ''`);
      addColumn(database, 'notes', 'inspiration_type', `TEXT NOT NULL DEFAULT ''`);
      addColumn(database, 'knowledge_items', 'knowledge_type', `TEXT NOT NULL DEFAULT ''`);
      database.exec(`
        CREATE TABLE IF NOT EXISTS taxonomy_nodes (
          workspace_id TEXT NOT NULL,
          key TEXT NOT NULL,
          dimension TEXT NOT NULL,
          name TEXT NOT NULL,
          parent_key TEXT,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          created_by TEXT NOT NULL DEFAULT 'system',
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, key),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );
        CREATE INDEX IF NOT EXISTS idx_taxonomy_nodes_dimension
          ON taxonomy_nodes(workspace_id, dimension, sort_order, key);

        CREATE TABLE IF NOT EXISTS resource_taxonomy (
          workspace_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          taxonomy_key TEXT NOT NULL,
          is_primary INTEGER NOT NULL DEFAULT 0,
          assigned_by TEXT NOT NULL DEFAULT 'ai',
          confidence TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, resource_type, resource_id, taxonomy_key),
          FOREIGN KEY(workspace_id, taxonomy_key) REFERENCES taxonomy_nodes(workspace_id, key)
        );
        CREATE INDEX IF NOT EXISTS idx_resource_taxonomy_resource
          ON resource_taxonomy(workspace_id, resource_type, resource_id);
        CREATE INDEX IF NOT EXISTS idx_resource_taxonomy_key
          ON resource_taxonomy(workspace_id, taxonomy_key, resource_type);

        CREATE TABLE IF NOT EXISTS taxonomy_proposals (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          dimension TEXT NOT NULL,
          key TEXT NOT NULL,
          name TEXT NOT NULL,
          parent_key TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );
        CREATE INDEX IF NOT EXISTS idx_taxonomy_proposals_resource
          ON taxonomy_proposals(workspace_id, resource_type, resource_id, created_at DESC);
      `);
      seedWorkspaceTaxonomy(database, DEFAULT_WORKSPACE_ID);
    },
  },
  {
    version: 17,
    name: 'resource-taggings',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS resource_taggings (
          workspace_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          tag_catalog_version TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          truncated_for_model INTEGER NOT NULL DEFAULT 0,
          analyzed_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, resource_type, resource_id),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );
        CREATE INDEX IF NOT EXISTS idx_resource_taggings_catalog
          ON resource_taggings(workspace_id, resource_type, tag_catalog_version, prompt_version);
      `);
    },
  },
  {
    version: 18,
    name: 'inspiration-capture-provenance',
    up(database) {
      addColumn(database, 'notes', 'source_url', `TEXT NOT NULL DEFAULT ''`);
      addColumn(database, 'notes', 'source_title', `TEXT NOT NULL DEFAULT ''`);
      addColumn(database, 'notes', 'capture_channel', `TEXT NOT NULL DEFAULT 'web'`);
      addColumn(database, 'notes', 'source_app', `TEXT NOT NULL DEFAULT ''`);
      database.prepare(`UPDATE notes SET capture_channel = CASE
        WHEN source_type = 'ai-run' THEN 'agent'
        WHEN source_type = 'content-item' THEN 'feed'
        ELSE 'web'
      END`).run();
    },
  },
  {
    version: 19,
    name: 'inspiration-offline-sync',
    up(database) {
      addColumn(database, 'notes', 'client_mutation_id', `TEXT NOT NULL DEFAULT ''`);
      addColumn(database, 'notes', 'captured_at', `INTEGER NOT NULL DEFAULT 0`);
      database.prepare(`UPDATE notes SET captured_at = created_at WHERE captured_at = 0`).run();
      database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_client_mutation
        ON notes(workspace_id, client_mutation_id)
        WHERE client_mutation_id != ''`);
    },
  },
  {
    version: 20,
    name: 'hide-legacy-posts',
    up(database) {
      addColumn(database, 'posts', 'hidden_at', 'INTEGER');
    },
  },
  {
    version: 21,
    name: 'inspiration-work-packages',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS work_packages (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          inspiration_id TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL,
          status TEXT NOT NULL,
          restart_required TEXT NOT NULL DEFAULT 'unknown',
          restart_applied_at INTEGER,
          claimed_by TEXT NOT NULL DEFAULT '',
          claimed_at INTEGER,
          claim_expires_at INTEGER,
          completed_at INTEGER,
          result_summary TEXT NOT NULL DEFAULT '',
          client_mutation_id TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(inspiration_id) REFERENCES notes(id)
        );
        CREATE INDEX IF NOT EXISTS idx_work_packages_status
          ON work_packages(workspace_id, status, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_packages_mutation
          ON work_packages(workspace_id, client_mutation_id)
          WHERE client_mutation_id != '';
      `);
    },
  },
  {
    version: 22,
    name: 'work-package-cursor-session',
    up(database) {
      addColumn(database, 'work_packages', 'cursor_agent_id', "TEXT NOT NULL DEFAULT ''");
      addColumn(database, 'work_packages', 'cursor_run_id', "TEXT NOT NULL DEFAULT ''");
      addColumn(database, 'work_packages', 'dispatch_job_id', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 23,
    name: 'feed-identity-fingerprints',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS feed_identity_fingerprints (
          workspace_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          identity_hash TEXT NOT NULL,
          external_id TEXT NOT NULL DEFAULT '',
          hidden_at INTEGER,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, provider, identity_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_feed_identity_fingerprints_external
          ON feed_identity_fingerprints(workspace_id, provider, external_id)
          WHERE external_id != '';
        CREATE INDEX IF NOT EXISTS idx_feed_identity_fingerprints_hidden
          ON feed_identity_fingerprints(workspace_id, provider, hidden_at)
          WHERE hidden_at IS NOT NULL;
      `);
      const existing = database.prepare(`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'captures'`).get();
      if (!existing) return;
      const rows = database.prepare(`SELECT c.workspace_id AS workspace_id,
          c.provider AS provider,
          c.external_id AS external_id,
          c.captured_at AS captured_at,
          c.metadata_json AS metadata_json,
          ci.author_name AS author_name,
          ci.body AS body,
          ci.title AS title,
          uis.is_hidden AS is_hidden,
          uis.updated_at AS state_updated_at
        FROM captures c
        LEFT JOIN content_items ci ON ci.capture_id = c.id
        LEFT JOIN user_item_states uis
          ON uis.workspace_id = ci.workspace_id AND uis.content_item_id = ci.id`).all();
      const insert = database.prepare(`INSERT OR IGNORE INTO feed_identity_fingerprints
        (workspace_id, provider, identity_hash, external_id, hidden_at, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const row of rows) {
        const metadata = readJsonObject(row.metadata_json);
        const seenAt = Number(row.captured_at) || Date.now();
        const hiddenAt = row.is_hidden ? (Number(row.state_updated_at) || seenAt) : null;
        insert.run(
          row.workspace_id,
          row.provider,
          computeFeedIdentityHash({
            provider: row.provider,
            authorHandle: metadata.authorHandle || '',
            authorName: row.author_name || '',
            text: metadata.originalText || row.body || row.title || '',
            externalId: row.external_id || '',
          }),
          String(row.external_id || ''),
          hiddenAt,
          seenAt,
          seenAt,
        );
      }
    },
  },
  {
    version: 24,
    name: 'work-package-parent-session',
    up(database) {
      addColumn(database, 'work_packages', 'parent_work_package_id', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 25,
    name: 'knowledge-attachments',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS attachments (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          mime TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          original_name TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_attachments_workspace
          ON attachments(workspace_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS resource_attachments (
          workspace_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          attachment_id TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (workspace_id, resource_type, resource_id, attachment_id)
        );
        CREATE INDEX IF NOT EXISTS idx_resource_attachments_attachment
          ON resource_attachments(attachment_id);
        CREATE INDEX IF NOT EXISTS idx_resource_attachments_resource
          ON resource_attachments(workspace_id, resource_type, resource_id, sort_order);
      `);
    },
  },
  {
    version: 26,
    name: 'personal-asset-ledger',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS personal_asset_types (
          workspace_id TEXT NOT NULL,
          key TEXT NOT NULL,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL,
          hidden_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, key)
        );
        CREATE TABLE IF NOT EXISTS personal_asset_accounts (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          type_key TEXT NOT NULL,
          name TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL,
          amount_decimal TEXT NOT NULL,
          currency TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          archived_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_personal_asset_accounts_workspace
          ON personal_asset_accounts(workspace_id, type_key, sort_order);
        CREATE TABLE IF NOT EXISTS personal_asset_snapshots (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          label TEXT NOT NULL,
          total_decimal TEXT NOT NULL,
          increase_decimal TEXT NOT NULL,
          increase_rate_decimal TEXT NOT NULL,
          recorded_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (workspace_id, label)
        );
        CREATE INDEX IF NOT EXISTS idx_personal_asset_snapshots_workspace
          ON personal_asset_snapshots(workspace_id, recorded_at);
        CREATE TABLE IF NOT EXISTS personal_asset_snapshot_lines (
          snapshot_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          type_key TEXT NOT NULL,
          amount_decimal TEXT NOT NULL,
          PRIMARY KEY (snapshot_id, account_id)
        );
        CREATE TABLE IF NOT EXISTS personal_asset_dividends (
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          value_decimal TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (workspace_id, name)
        );
      `);
    },
  },
  {
    version: 27,
    name: 'personal-asset-snapshot-label-repeat',
    up(database) {
      database.exec(`
        CREATE TABLE personal_asset_snapshots_v27 (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          label TEXT NOT NULL,
          total_decimal TEXT NOT NULL,
          increase_decimal TEXT NOT NULL,
          increase_rate_decimal TEXT NOT NULL,
          recorded_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO personal_asset_snapshots_v27
          (id, workspace_id, label, total_decimal, increase_decimal, increase_rate_decimal, recorded_at, created_at)
          SELECT id, workspace_id, label, total_decimal, increase_decimal, increase_rate_decimal, recorded_at, created_at
          FROM personal_asset_snapshots;
        DROP TABLE personal_asset_snapshots;
        ALTER TABLE personal_asset_snapshots_v27 RENAME TO personal_asset_snapshots;
        CREATE INDEX IF NOT EXISTS idx_personal_asset_snapshots_workspace
          ON personal_asset_snapshots(workspace_id, recorded_at);
      `);
    },
  },
  {
    version: 28,
    name: 'agent-run-event-projection',
    up(database) {
      database.exec(`
        CREATE TABLE agent_run_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          event_name TEXT NOT NULL,
          detail_json TEXT NOT NULL DEFAULT '{}',
          occurred_at INTEGER NOT NULL,
          FOREIGN KEY(run_id) REFERENCES jobs(id)
        );
        CREATE INDEX idx_agent_run_events_run
          ON agent_run_events(run_id, id);
        CREATE INDEX idx_agent_run_events_workspace
          ON agent_run_events(workspace_id, id);
      `);
    },
  },
  {
    version: 29,
    name: 'market-history-cache',
    up(database) {
      database.exec(`
        CREATE TABLE market_history_cache (
          symbol TEXT NOT NULL,
          range_key TEXT NOT NULL,
          interval_key TEXT NOT NULL,
          bars_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (symbol, range_key, interval_key)
        );
      `);
    },
  },
  {
    version: 30,
    name: 'job-schedules',
    up(database) {
      database.exec(`
        CREATE TABLE job_schedules (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          schedule_key TEXT NOT NULL,
          job_type TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          schedule_json TEXT NOT NULL,
          input_json TEXT NOT NULL DEFAULT '{}',
          priority INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          next_run_at INTEGER NOT NULL,
          last_enqueued_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(workspace_id, schedule_key),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );
        CREATE INDEX idx_job_schedules_due ON job_schedules(enabled, next_run_at);
      `);
    },
  },
  {
    version: 31,
    name: 'strategy-snapshots',
    up(database) {
      database.exec(`
        CREATE TABLE strategy_snapshots (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          strategy_key TEXT NOT NULL,
          as_of INTEGER NOT NULL,
          status TEXT NOT NULL,
          factors_json TEXT NOT NULL,
          warnings_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          UNIQUE(workspace_id, strategy_key, as_of),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );
        CREATE INDEX idx_strategy_snapshots_lookup
          ON strategy_snapshots(workspace_id, strategy_key, as_of DESC);
      `);
    },
  },
  {
    version: 32,
    name: 'daily-report-briefs',
    up(database) {
      database.exec(`
        CREATE TABLE daily_report_briefs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          report_id TEXT NOT NULL,
          report_date TEXT NOT NULL,
          status TEXT NOT NULL,
          source_report_updated_at INTEGER NOT NULL,
          input_hash TEXT NOT NULL,
          input_snapshot_json TEXT NOT NULL,
          brief_json TEXT NOT NULL,
          provider_id TEXT NOT NULL DEFAULT '',
          model_id TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(workspace_id, report_id),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY(report_id) REFERENCES daily_reports(id)
        );
        CREATE INDEX idx_daily_report_briefs_date
          ON daily_report_briefs(workspace_id, report_date DESC);
      `);
    },
  },
  {
    version: 33,
    name: 'media-index',
    up(database) {
      database.exec(`
        CREATE TABLE media_source_states (
          workspace_id TEXT NOT NULL,
          source_key TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0,
          host_direct_verified INTEGER NOT NULL DEFAULT 0,
          body_use_acknowledged INTEGER NOT NULL DEFAULT 0,
          health TEXT NOT NULL DEFAULT 'disabled',
          health_detail TEXT NOT NULL DEFAULT '',
          etag TEXT NOT NULL DEFAULT '',
          last_modified TEXT NOT NULL DEFAULT '',
          feed_hash TEXT NOT NULL DEFAULT '',
          last_probe_json TEXT NOT NULL DEFAULT '',
          last_sync_at INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, source_key),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );

        CREATE TABLE media_index_entries (
          workspace_id TEXT NOT NULL,
          external_id TEXT NOT NULL,
          source_key TEXT NOT NULL,
          publisher_key TEXT NOT NULL,
          channel TEXT NOT NULL,
          canonical_url TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          published_at INTEGER,
          published_at_raw TEXT NOT NULL DEFAULT '',
          content_level TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          origin_url TEXT NOT NULL DEFAULT '',
          discovered_via_json TEXT NOT NULL DEFAULT '',
          observed_at INTEGER NOT NULL,
          body_hash TEXT NOT NULL DEFAULT '',
          truncated INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, external_id),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );
        CREATE INDEX idx_media_index_channel
          ON media_index_entries(workspace_id, channel, observed_at DESC);

        CREATE TABLE media_budget_days (
          workspace_id TEXT NOT NULL,
          day_key TEXT NOT NULL,
          new_metadata INTEGER NOT NULL DEFAULT 0,
          selected_bodies INTEGER NOT NULL DEFAULT 0,
          deferred_count INTEGER NOT NULL DEFAULT 0,
          earliest_deferred_at INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, day_key),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );

        CREATE TABLE media_source_budgets (
          workspace_id TEXT NOT NULL,
          day_key TEXT NOT NULL,
          source_key TEXT NOT NULL,
          bodies INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, day_key, source_key),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );

        CREATE TABLE media_body_snapshots (
          workspace_id TEXT NOT NULL,
          external_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          body_hash TEXT NOT NULL,
          body_text TEXT NOT NULL,
          truncated INTEGER NOT NULL DEFAULT 0,
          content_level TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, external_id, revision),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );
      `);
    },
  },
  {
    version: 34,
    name: 'media-body-observation',
    up(database) {
      database.exec(`
        ALTER TABLE media_index_entries ADD COLUMN fetch_state_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE media_index_entries ADD COLUMN feed_body_html TEXT NOT NULL DEFAULT '';
        ALTER TABLE media_body_snapshots ADD COLUMN article_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE media_body_snapshots ADD COLUMN brief_json TEXT;
        ALTER TABLE media_budget_days ADD COLUMN body_requests INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE media_source_budgets ADD COLUMN requests INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 35,
    name: 'media-processing-state',
    up(database) {
      database.exec(`CREATE TABLE media_article_processing (
        workspace_id TEXT NOT NULL, external_id TEXT NOT NULL, body_hash TEXT NOT NULL,
        brief_status TEXT NOT NULL, brief_reason TEXT NOT NULL DEFAULT '', last_attempt_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id,external_id,body_hash), FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
      );`);
    },
  },
  {
    version: 36,
    name: 'media-native-channel-discovery',
    up(database) {
      database.exec(`
        ALTER TABLE media_source_states ADD COLUMN ingestion_policy TEXT NOT NULL DEFAULT '';
        ALTER TABLE media_index_entries ADD COLUMN publisher_name TEXT NOT NULL DEFAULT '';
        ALTER TABLE media_index_entries ADD COLUMN author_name TEXT NOT NULL DEFAULT '';
        CREATE INDEX media_index_url ON media_index_entries(workspace_id, canonical_url);
        CREATE TABLE media_entry_discoveries (
          workspace_id TEXT NOT NULL, external_id TEXT NOT NULL, source_key TEXT NOT NULL,
          entry_url TEXT NOT NULL, list_position INTEGER, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
          PRIMARY KEY(workspace_id, external_id, source_key),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );
        INSERT INTO media_entry_discoveries
          SELECT workspace_id,external_id,source_key,'',NULL,created_at,observed_at FROM media_index_entries;
      `);
    },
  },
];

// Append-only: the media migrations above remain unchanged.
migrations.push({
  version: 37, name: 'daily_analysis_v2',
  up(database) {
    database.exec(`
      CREATE TABLE daily_tracking_questions (
        workspace_id TEXT NOT NULL, id TEXT NOT NULL, question_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,id)
      );
      CREATE TABLE daily_analysis_runs (
        workspace_id TEXT NOT NULL, run_key TEXT NOT NULL, report_date TEXT NOT NULL,
        snapshot_json TEXT NOT NULL, status TEXT NOT NULL, owner TEXT NOT NULL,
        lease_until INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_id,run_key)
      );
      CREATE TABLE daily_analysis_stages (
        workspace_id TEXT NOT NULL, report_date TEXT NOT NULL, stage_key TEXT NOT NULL,
        input_hash TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT,
        status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_id,report_date,stage_key,input_hash)
      );
      CREATE TABLE daily_brief_versions (
        workspace_id TEXT NOT NULL, report_date TEXT NOT NULL, generated_at INTEGER NOT NULL,
        brief_json TEXT NOT NULL, input_snapshot_json TEXT NOT NULL,
        PRIMARY KEY(workspace_id,report_date,generated_at)
      );
      CREATE INDEX daily_analysis_runs_date ON daily_analysis_runs(workspace_id,report_date,updated_at);
    `);
  },
});

migrations.push({
  version: 38, name: 'hourly_information_snapshots',
  up(database) {
    database.exec(`CREATE TABLE hourly_information_snapshots (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, hour_start INTEGER NOT NULL,
      material_version TEXT NOT NULL, frozen_json TEXT NOT NULL, digest_json TEXT,
      status TEXT NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL,
      error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      UNIQUE(workspace_id,hour_start,material_version)
    );
    CREATE INDEX hourly_information_window ON hourly_information_snapshots(workspace_id,hour_start,updated_at);`);
  },
});

migrations.push({
  version: 39, name: 'hourly_information_current_heads',
  up(database) {
    database.exec(`CREATE TABLE hourly_information_heads (
      workspace_id TEXT NOT NULL, hour_start INTEGER NOT NULL, snapshot_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,hour_start)
    );
    INSERT INTO hourly_information_heads (workspace_id,hour_start,snapshot_id,updated_at)
      SELECT workspace_id,hour_start,id,updated_at FROM (
        SELECT *,ROW_NUMBER() OVER (PARTITION BY workspace_id,hour_start ORDER BY updated_at DESC,rowid DESC) AS position
        FROM hourly_information_snapshots WHERE status='completed'
          AND json_extract(digest_json,'$.window.startAt')=hour_start
          AND json_extract(digest_json,'$.window.endAt')=hour_start+3600000
      ) WHERE position=1;`);
  },
});

migrations.push({
  version: 40, name: 'hardware_prices_and_media_identity',
  up(database) {
    database.exec(`
      CREATE TABLE hardware_price_snapshots (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, source_key TEXT NOT NULL, page_key TEXT NOT NULL,
        source_url TEXT NOT NULL, title TEXT NOT NULL, captured_at INTEGER NOT NULL, content_hash TEXT NOT NULL,
        artifact_path TEXT NOT NULL, format TEXT NOT NULL, parser_version TEXT NOT NULL, warnings_json TEXT NOT NULL,
        UNIQUE(workspace_id,source_key,page_key,content_hash,parser_version)
      );
      CREATE TABLE hardware_price_observations (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, series_key TEXT NOT NULL, period_key TEXT NOT NULL,
        revision INTEGER NOT NULL, previous_id TEXT, value_hash TEXT NOT NULL, snapshot_id TEXT NOT NULL,
        captured_at INTEGER NOT NULL, period_start INTEGER, source_updated_at INTEGER, is_current INTEGER NOT NULL,
        row_json TEXT NOT NULL, UNIQUE(workspace_id,series_key,period_key,revision)
      );
      CREATE INDEX hardware_price_series ON hardware_price_observations(workspace_id,series_key,period_start,revision);
      CREATE TABLE hardware_price_snapshot_rows (
        workspace_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, table_index INTEGER NOT NULL, row_index INTEGER NOT NULL,
        observation_id TEXT NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY(workspace_id,snapshot_id,table_index,row_index)
      );
      CREATE TABLE hardware_price_legacy_links (
        workspace_id TEXT NOT NULL, external_id TEXT NOT NULL, content_item_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
        PRIMARY KEY(workspace_id,external_id)
      );
      ALTER TABLE media_index_entries ADD COLUMN article_kind TEXT NOT NULL DEFAULT 'article';
      CREATE TABLE media_entry_legacy_links (
        workspace_id TEXT NOT NULL, external_id TEXT NOT NULL, content_item_id TEXT NOT NULL,
        legacy_provider TEXT NOT NULL, legacy_external_id TEXT NOT NULL,
        PRIMARY KEY(workspace_id,external_id)
      );
    `);
  },
});

migrations.push({
  version: 41, name: 'model_usage_query_index',
  up(database) {
    database.exec(`CREATE TABLE model_usage_index (
      workspace_id TEXT NOT NULL, id TEXT NOT NULL, job_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(workspace_id,id)
    );
    CREATE INDEX model_usage_by_job ON model_usage_index(workspace_id,job_id,occurred_at);
    CREATE INDEX model_usage_by_time ON model_usage_index(workspace_id,occurred_at);`);
  },
});

migrations.push({
  version: 42, name: 'information_condensation_tree',
  up(database) {
    database.exec(`CREATE TABLE information_tree_nodes (workspace_id TEXT NOT NULL,id TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(workspace_id,id));
      CREATE TABLE information_tree_editions (workspace_id TEXT NOT NULL,id TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(workspace_id,id));
      CREATE TABLE information_tree_heads (workspace_id TEXT NOT NULL,period_key TEXT NOT NULL,layer TEXT NOT NULL,start_at INTEGER NOT NULL,published_id TEXT,attempt_id TEXT NOT NULL,PRIMARY KEY(workspace_id,period_key));
      CREATE TABLE information_tree_leases (workspace_id TEXT NOT NULL,cache_key TEXT NOT NULL,owner TEXT NOT NULL,lease_until INTEGER NOT NULL,PRIMARY KEY(workspace_id,cache_key));`);
  },
});

migrations.push({version:43,name:'tree_information_preparation_and_policy',up(database) {
  database.exec(`CREATE TABLE information_tree_information_heads (workspace_id TEXT NOT NULL,source_id TEXT NOT NULL,node_id TEXT NOT NULL,source_version TEXT NOT NULL,event_at INTEGER NOT NULL,source_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,source_id));
    CREATE INDEX information_tree_information_window ON information_tree_information_heads(workspace_id,event_at);
    CREATE TABLE information_tree_policies (workspace_id TEXT PRIMARY KEY,policy_hash TEXT NOT NULL);`);
}});

migrations.push({version:44,name:'gemini_article_quota_admission',up(database) {
  database.exec(`CREATE TABLE model_quota_reservations(id TEXT PRIMARY KEY,project TEXT NOT NULL,model TEXT NOT NULL,at INTEGER NOT NULL,estimated_tokens INTEGER NOT NULL);
    CREATE INDEX model_quota_time ON model_quota_reservations(at);
    CREATE INDEX model_quota_project_time ON model_quota_reservations(project,model,at);
    CREATE TABLE model_quota_cooldowns(project TEXT NOT NULL,model TEXT NOT NULL,until_at INTEGER NOT NULL,PRIMARY KEY(project,model));`);
}});

migrations.push({version:45,name:'gemini_article_account_leases',up(database) {
  database.exec(`CREATE TABLE model_quota_leases(project TEXT NOT NULL,model TEXT NOT NULL,owner TEXT NOT NULL,until_at INTEGER NOT NULL,PRIMARY KEY(project,model));`);
}});

migrations.push({version:46,name:'daily_editorial',up(database) {
  database.exec(`CREATE TABLE information_tree_editorials (workspace_id TEXT NOT NULL,id TEXT NOT NULL,start_at INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(workspace_id,id));
    CREATE INDEX information_tree_editorials_window ON information_tree_editorials(workspace_id,start_at);
    CREATE TABLE information_tree_editorial_heads (workspace_id TEXT NOT NULL,period_key TEXT NOT NULL,published_id TEXT,PRIMARY KEY(workspace_id,period_key));`);
}});

migrations.push({version:47,name:'research_recall',up(database) {
  database.exec(`CREATE TABLE research_releases (
      workspace_id TEXT NOT NULL, release_id TEXT NOT NULL, catalog_id TEXT NOT NULL, label_version TEXT NOT NULL,
      content_hash TEXT NOT NULL, value_json TEXT NOT NULL, activated_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, release_id));
    CREATE UNIQUE INDEX research_releases_one_active ON research_releases(workspace_id) WHERE active=1;
    CREATE TABLE research_pools (
      workspace_id TEXT NOT NULL, pool_id TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
      member_count INTEGER NOT NULL, frozen_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, pool_id));
    CREATE TABLE research_pool_members (
      workspace_id TEXT NOT NULL, pool_id TEXT NOT NULL, ordinal INTEGER NOT NULL, lane TEXT NOT NULL,
      resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, source_version TEXT NOT NULL, event_at INTEGER NOT NULL,
      title TEXT NOT NULL, text TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', origin_type TEXT NOT NULL, origin_id TEXT NOT NULL,
      node_id TEXT, column_tag_id TEXT, history INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (workspace_id, pool_id, ordinal));
    CREATE TABLE research_tag_judgments (
      workspace_id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, source_version TEXT NOT NULL,
      tag_id TEXT NOT NULL, definition_hash TEXT NOT NULL, prompt_version TEXT NOT NULL, model_id TEXT NOT NULL, input_hash TEXT NOT NULL,
      status TEXT NOT NULL, matched INTEGER, claim_token TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
      error_code TEXT NOT NULL DEFAULT '', request_count INTEGER NOT NULL DEFAULT 0, pass TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, resource_type, resource_id, source_version, tag_id, definition_hash, prompt_version, model_id, input_hash));
    CREATE TABLE research_relevance_judgments (
      workspace_id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, source_version TEXT NOT NULL,
      question_id TEXT NOT NULL, question_hash TEXT NOT NULL, prompt_version TEXT NOT NULL, model_id TEXT NOT NULL, input_hash TEXT NOT NULL,
      status TEXT NOT NULL, verdict TEXT NOT NULL DEFAULT '', claim_token TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
      error_code TEXT NOT NULL DEFAULT '', request_count INTEGER NOT NULL DEFAULT 0, pass TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, resource_type, resource_id, source_version, question_id, question_hash, prompt_version, model_id, input_hash));
    CREATE TABLE research_runs (
      workspace_id TEXT NOT NULL, id TEXT NOT NULL, release_id TEXT NOT NULL, content_hash TEXT NOT NULL, question_hash TEXT NOT NULL,
      status TEXT NOT NULL, report_id TEXT NOT NULL DEFAULT '', value_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, id));
    CREATE TABLE research_reports (
      workspace_id TEXT NOT NULL, id TEXT NOT NULL, question_id TEXT NOT NULL, start_at INTEGER NOT NULL, value_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, id));
    CREATE TABLE research_report_heads (
      workspace_id TEXT NOT NULL, period_key TEXT NOT NULL, report_id TEXT NOT NULL, PRIMARY KEY (workspace_id, period_key));`);
}});

migrations.push({ version: 48, name: 'etf_whale_tracking', up(database) {
  database.exec(`
    CREATE TABLE etf_whale_instruments (
      code TEXT PRIMARY KEY,
      exchange TEXT NOT NULL,
      name TEXT NOT NULL,
      group_key TEXT NOT NULL,
      reference_pool INTEGER NOT NULL,
      source TEXT NOT NULL,
      verified_on TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE etf_whale_fetches (
      source TEXT NOT NULL,
      date_start TEXT NOT NULL,
      date_end TEXT NOT NULL,
      status TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      blob_path TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      captured_at INTEGER NOT NULL,
      PRIMARY KEY (source, date_start, date_end)
    );
    CREATE TABLE etf_whale_shares (
      source TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      shares REAL NOT NULL,
      raw_value REAL NOT NULL,
      raw_unit TEXT NOT NULL,
      blob_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      PRIMARY KEY (source, trade_date, code)
    );
    CREATE INDEX etf_whale_shares_code_date ON etf_whale_shares(code, trade_date);
    CREATE TABLE etf_whale_quotes (
      source TEXT NOT NULL,
      code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume_lots REAL NOT NULL,
      volume_shares REAL NOT NULL,
      typical_price REAL NOT NULL,
      turnover_cny REAL NOT NULL,
      adjust TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      PRIMARY KEY (source, code, trade_date, adjust)
    );
    CREATE TABLE etf_whale_adjustments (
      code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      event_type TEXT NOT NULL,
      share_ratio REAL,
      price_ratio REAL,
      comparable INTEGER NOT NULL,
      note TEXT NOT NULL,
      PRIMARY KEY (code, trade_date, event_type)
    );
    CREATE TABLE etf_whale_daily (
      code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      algorithm TEXT NOT NULL,
      raw_shares REAL,
      delta_shares REAL,
      share_change_pct REAL,
      close_price REAL,
      typical_price REAL,
      turnover_cny REAL,
      volume_shares REAL,
      flow_cny REAL,
      comparable INTEGER NOT NULL,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      computed_at INTEGER NOT NULL,
      PRIMARY KEY (code, trade_date, algorithm)
    );
    CREATE INDEX etf_whale_daily_date ON etf_whale_daily(trade_date, algorithm);
    CREATE TABLE etf_whale_disclosures (
      code TEXT NOT NULL,
      source TEXT NOT NULL,
      report_end TEXT NOT NULL,
      announced_on TEXT,
      captured_on TEXT NOT NULL,
      ratio_pct REAL,
      value_cny REAL,
      total_shares REAL,
      PRIMARY KEY (code, source, report_end)
    );
  `);
}});

migrations.push({ version: 49, name: 'reading_hour_snapshots', up(database) {
  database.exec(`CREATE TABLE reading_hour_snapshots (
      workspace_id TEXT NOT NULL, id TEXT NOT NULL, start_at INTEGER NOT NULL, value_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id));
    CREATE TABLE reading_hour_heads (
      workspace_id TEXT NOT NULL, period_key TEXT NOT NULL, published_id TEXT, attempt_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, period_key));`);
}});

migrations.push({ version: 50, name: 'feed_translation_failures', up(database) {
  database.exec(`CREATE TABLE feed_translation_failures (
      workspace_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      target_lang TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      next_retry_at INTEGER,
      last_error TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, item_id, target_lang)
    );`);
}});

migrations.push({ version: 51, name: 'event_quote_snapshots', up(database) {
  database.exec(`CREATE TABLE event_quote_snapshots (
      symbol TEXT NOT NULL,
      probability TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (symbol, observed_at)
    );
    CREATE INDEX idx_event_quote_snapshots_observed ON event_quote_snapshots(observed_at);`);
}});

migrations.push({ version: 52, name: 'investor_discussion_digests', up(database) {
  database.exec(`CREATE TABLE investor_discussion_digests (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      digest_date TEXT NOT NULL,
      status TEXT NOT NULL,
      generated_at INTEGER,
      model TEXT NOT NULL DEFAULT '',
      coverage_json TEXT NOT NULL DEFAULT '{}',
      sections_json TEXT NOT NULL DEFAULT '[]',
      error_text TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(workspace_id, digest_date)
    );`);
}});

migrations.push({ version: 53, name: 'gemini_quota_key_identity', up(database) {
  database.exec(`ALTER TABLE model_quota_reservations ADD COLUMN key_env TEXT NOT NULL DEFAULT '';
    CREATE INDEX model_quota_key_time ON model_quota_reservations(key_env, model, at);`);
}});

migrations.push({ version: 54, name: 'hardware_price_fetch_checks', up(database) {
  database.exec(`
    ALTER TABLE hardware_price_snapshots ADD COLUMN last_checked_at INTEGER NOT NULL DEFAULT 0;
    UPDATE hardware_price_snapshots SET last_checked_at=captured_at WHERE last_checked_at=0;
    CREATE TABLE hardware_price_page_checks (
      workspace_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      page_key TEXT NOT NULL,
      last_checked_at INTEGER NOT NULL,
      last_changed_at INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, source_key, page_key)
    );
    INSERT INTO hardware_price_page_checks
      (workspace_id, source_key, page_key, last_checked_at, last_changed_at, content_hash, parser_version, snapshot_id)
    SELECT workspace_id, source_key, page_key, captured_at, captured_at, content_hash, parser_version, id
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY workspace_id, source_key, page_key ORDER BY captured_at DESC, id DESC) AS n
      FROM hardware_price_snapshots
    ) WHERE n=1;
  `);
}});

migrations.push({ version: 55, name: 'compute_price_snapshots', up(database) {
  database.exec(`
    CREATE TABLE compute_price_snapshots (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      quote_date TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      warnings_json TEXT NOT NULL,
      last_checked_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX compute_price_snapshot_identity
      ON compute_price_snapshots(workspace_id, source_key, quote_date, content_hash, parser_version);
    CREATE TABLE compute_price_checks (
      workspace_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      last_checked_at INTEGER NOT NULL,
      last_changed_at INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      quote_date TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, source_key)
    );
    CREATE TABLE token_price_observations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      sort_index INTEGER NOT NULL,
      model_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      name TEXT NOT NULL,
      quote_date TEXT NOT NULL,
      prompt_per_million TEXT NOT NULL,
      completion_per_million TEXT NOT NULL,
      context_length INTEGER,
      captured_at INTEGER NOT NULL
    );
    CREATE INDEX token_price_lookup ON token_price_observations(workspace_id, model_key, quote_date, captured_at);
    CREATE TABLE gpu_rent_observations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      sort_index INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      gpu_key TEXT NOT NULL,
      label TEXT NOT NULL,
      lane TEXT NOT NULL,
      quote_date TEXT NOT NULL,
      usd_per_hour TEXT NOT NULL,
      sample_count INTEGER,
      captured_at INTEGER NOT NULL
    );
    CREATE INDEX gpu_rent_lookup ON gpu_rent_observations(workspace_id, source_key, gpu_key, lane, quote_date, captured_at);
  `);
}});

migrations.push({ version: 56, name: 'investor_discussion_question_set', up(database) {
  database.exec(`ALTER TABLE investor_discussion_digests ADD COLUMN question_set TEXT NOT NULL DEFAULT '';`);
}});

migrations.push({ version: 57, name: 'api_access_tokens', up(database) {
  database.exec(`
    CREATE TABLE api_access_tokens (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      created_by_device_id TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    );
    CREATE UNIQUE INDEX api_access_tokens_hash ON api_access_tokens(token_hash);
    CREATE INDEX api_access_tokens_workspace ON api_access_tokens(workspace_id, created_at);
    CREATE TABLE api_token_access_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX api_token_access_log_created ON api_token_access_log(created_at);
    CREATE INDEX api_token_access_log_token ON api_token_access_log(token_id, created_at);
  `);
}});

migrations.push({ version: 58, name: 'runtime_snapshots', up(database) {
  database.exec(`CREATE TABLE runtime_snapshots (
      workspace_id TEXT NOT NULL,
      snapshot_key TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, snapshot_key)
    );`);
}});

migrations.push({ version: 59, name: 'feed_provider_page_indexes', up(database) {
  database.exec(`
    CREATE INDEX idx_captures_feed_sort
      ON captures(workspace_id, provider, source_account_id, captured_at DESC, id);
    CREATE INDEX idx_captures_provider_captured
      ON captures(workspace_id, provider, captured_at DESC, id);
    CREATE INDEX idx_captures_feed_filter
      ON captures(
        workspace_id,
        provider,
        source_account_id,
        json_extract(metadata_json, '$.filterMode'),
        json_extract(metadata_json, '$.filterDecision'),
        json_extract(metadata_json, '$.filterApplied'),
        captured_at DESC
      );
    CREATE INDEX idx_content_items_capture_cover
      ON content_items(capture_id, workspace_id, id);
    CREATE INDEX idx_user_item_states_feed_flags
      ON user_item_states(workspace_id, content_item_id, is_hidden, is_read, is_saved);
  `);
}});

migrations.push({ version: 60, name: 'tree_index_columns', up(database) {
  const names = (table) => new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (!names('information_tree_editions').has('edition_status')) {
    database.exec(`
      ALTER TABLE information_tree_editions ADD COLUMN edition_status TEXT NOT NULL DEFAULT '';
      ALTER TABLE information_tree_editions ADD COLUMN generated_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE information_tree_editions ADD COLUMN start_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE information_tree_editions ADD COLUMN end_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE information_tree_editions ADD COLUMN root_count INTEGER NOT NULL DEFAULT 0;
      UPDATE information_tree_editions SET
        edition_status = COALESCE(json_extract(value_json, '$.status'), ''),
        generated_at = COALESCE(json_extract(value_json, '$.generatedAt'), 0),
        start_at = COALESCE(json_extract(value_json, '$.window.startAt'), 0),
        end_at = COALESCE(json_extract(value_json, '$.window.endAt'), 0),
        root_count = COALESCE(json_array_length(value_json, '$.roots'), 0);
    `);
  }
  if (!names('information_tree_information_heads').has('window_start')) {
    database.exec(`
      ALTER TABLE information_tree_information_heads ADD COLUMN window_start INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE information_tree_information_heads ADD COLUMN window_end INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE information_tree_information_heads ADD COLUMN validator_version TEXT NOT NULL DEFAULT '';
      UPDATE information_tree_information_heads
        SET window_start = COALESCE(json_extract(n.value_json, '$.window.startAt'), 0),
            window_end = COALESCE(json_extract(n.value_json, '$.window.endAt'), 0),
            validator_version = COALESCE(json_extract(n.value_json, '$.validatorVersion'), '')
        FROM information_tree_nodes AS n
        WHERE n.workspace_id = information_tree_information_heads.workspace_id
          AND n.id = information_tree_information_heads.node_id;
    `);
  }
}});

migrations.push({ version: 61, name: 'gemini_model_pool_cursor', up(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS gemini_model_cursors (
    pool_key TEXT PRIMARY KEY,
    models_json TEXT NOT NULL,
    cursor INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`);
}});

migrations.push({ version: 62, name: 'model_usage_http_status', up(database) {
  addColumn(database, 'model_usage_index', 'http_status', 'INTEGER');
}});

migrations.push({ version: 64, name: 'capture_feed_filter_columns', up(database) {
  addColumn(database, 'captures', 'author_handle', `TEXT NOT NULL DEFAULT ''`);
  addColumn(database, 'captures', 'filter_mode', `TEXT NOT NULL DEFAULT ''`);
  addColumn(database, 'captures', 'filter_decision', `TEXT NOT NULL DEFAULT ''`);
  addColumn(database, 'captures', 'filter_applied', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(database, 'captures', 'filter_rule', `TEXT NOT NULL DEFAULT ''`);
  addColumn(database, 'captures', 'filter_reading', 'REAL');
  addColumn(database, 'captures', 'filter_specific', 'REAL');
  addColumn(database, 'captures', 'filter_sufficient', 'REAL');
  addColumn(database, 'captures', 'feed_filter_ready', 'INTEGER NOT NULL DEFAULT 0');
  database.exec(`CREATE INDEX IF NOT EXISTS idx_captures_filter_pending
    ON captures(captured_at, id) WHERE feed_filter_ready = 0`);
}});

migrations.push({ version: 65, name: 'outbox_payload_bytes', up(database) {
  addColumn(database, 'outbox_events', 'payload_bytes', 'INTEGER');
}});

migrations.push({ version: 66, name: 'outbox_sse_data', up(database) {
  addColumn(database, 'outbox_events', 'sse_data', 'TEXT');
}});

migrations.push({ version: 67, name: 'feed_translation_chunks', up(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS feed_translation_chunks (
      workspace_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      target_lang TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      chunk_hash TEXT NOT NULL,
      translated_text TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, item_id, target_lang, source_hash, chunk_index)
    );`);
}});

migrations.push({ version: 68, name: 'hardware_price_current_spec', up(database) {
  // Flags only. Rows, numbers and snapshot HTML stay.
  retireSupersededHardwareQuotes(database);
}});

export function backfillKnowledgeRevisionIndex(database) {
  database.exec(`
    INSERT OR IGNORE INTO knowledge_revisions
      (id, knowledge_id, revision, title, body, created_by_type, created_by_id, created_at)
    SELECT 'repair:' || id, id, COALESCE(current_revision, 1), title, body,
      CASE WHEN source = 'inspiration' THEN 'user' ELSE 'import' END, source_note_id, created_at
    FROM knowledge_items
    WHERE NOT EXISTS (
      SELECT 1 FROM knowledge_revisions r WHERE r.knowledge_id = knowledge_items.id
    );

    INSERT INTO knowledge_fts (knowledge_id, revision, title, body)
    SELECT k.id, k.current_revision, k.title, k.body
    FROM knowledge_items k
    WHERE NOT EXISTS (
      SELECT 1 FROM knowledge_fts f
      WHERE f.knowledge_id = k.id AND f.revision = k.current_revision
    );

    INSERT OR IGNORE INTO knowledge_links
      (knowledge_id, source_type, source_id, relation_type, created_at)
    SELECT knowledge_id, 'inspiration', id, 'derived_from', COALESCE(archived_at, updated_at, created_at)
    FROM notes
    WHERE status = 'archived' AND knowledge_id IS NOT NULL AND knowledge_id != '';
  `);
}

function readJsonObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function backfillAiRunQuestions(database) {
  const updateRun = database.prepare(`UPDATE ai_runs SET input_text = ?
    WHERE id = ? AND (input_text = '' OR input_text IS NULL)`);
  for (const job of database.prepare(`SELECT id, input_json FROM jobs WHERE type = 'ai.agent.run'`).all()) {
    const message = String(readJsonObject(job.input_json).message || '').trim();
    if (!message) continue;
    const runs = database.prepare(`SELECT id FROM ai_runs
      WHERE source_id = ? AND (input_text = '' OR input_text IS NULL)`).all(job.id);
    for (const run of runs) updateRun.run(message, run.id);
  }
  if (database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes'`).get()) {
    for (const note of database.prepare('SELECT id, body FROM notes').all()) {
      const body = String(note.body || '').trim();
      if (!body) continue;
      const runs = database.prepare(`SELECT id FROM ai_runs
        WHERE source_type = 'inspiration' AND source_id = ? AND (input_text = '' OR input_text IS NULL)`).all(note.id);
      for (const run of runs) updateRun.run(body, run.id);
    }
  }
  const firstRun = database.prepare(`SELECT input_text FROM ai_runs
    WHERE session_id = ? AND input_text != '' ORDER BY created_at ASC LIMIT 1`);
  const updateSession = database.prepare('UPDATE ai_sessions SET title = ? WHERE id = ?');
  for (const session of database.prepare('SELECT id, title FROM ai_sessions').all()) {
    const run = firstRun.get(session.id);
    const question = String(run?.input_text || '').replace(/\s+/g, ' ').trim();
    if (!question) continue;
    const title = question.length > 36 ? `${question.slice(0, 36)}…` : question;
    if (title && title !== session.title) updateSession.run(title, session.id);
  }
}

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
