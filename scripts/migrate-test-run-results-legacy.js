import 'dotenv/config'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

function libsqlEnv() {
  const url = (process.env.LIBSQL_URL || process.env.TURSO_DATABASE_URL || '').trim()
  const authToken = (process.env.LIBSQL_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || '').trim()
  return { url, authToken }
}

function resolveDatabasePath() {
  if (process.env.DATABASE_PATH) {
    return path.resolve(process.env.DATABASE_PATH)
  }
  return path.join(projectRoot, 'qahelper.db')
}

function rowFromResultSet(r, index = 0) {
  if (!r?.rows?.length || index >= r.rows.length) return undefined
  const row = r.rows[index]
  const cols = r.columns
  const o = {}
  for (let i = 0; i < cols.length; i += 1) o[cols[i]] = row[i]
  return o
}

function migrationSql() {
  return `
    DROP TABLE IF EXISTS test_run_results_new;

    CREATE TABLE test_run_results_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      test_case_id INTEGER,
      status TEXT NOT NULL,
      notes TEXT,
      snapshot_name TEXT NOT NULL,
      snapshot_what_to_test TEXT NOT NULL,
      snapshot_expected_result TEXT NOT NULL,
      snapshot_expected_outcome TEXT DEFAULT 'should_pass',
      snapshot_test_type TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES test_runs(id)
    );

    INSERT INTO test_run_results_new (
      id, run_id, test_case_id, status, notes,
      snapshot_name, snapshot_what_to_test, snapshot_expected_result, snapshot_expected_outcome, snapshot_test_type, created_at
    )
    SELECT
      id, run_id, test_case_id, status, notes,
      snapshot_name, snapshot_what_to_test, snapshot_expected_result, 'should_pass', snapshot_test_type, created_at
    FROM test_run_results;

    DROP TABLE test_run_results;
    ALTER TABLE test_run_results_new RENAME TO test_run_results;
  `
}

async function migrateTurso(url, authToken) {
  const { createClient } = await import('@libsql/client')
  const client = createClient({ url, authToken })
  const rs = await client.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'test_run_results'"
  )
  const schemaSql = String(rowFromResultSet(rs, 0)?.sql || '').toLowerCase()

  if (!schemaSql) {
    console.log('[migration] test_run_results table not found, nothing to migrate.')
    return
  }
  if (!schemaSql.includes('references test_cases')) {
    console.log('[migration] schema already up to date, nothing to migrate.')
    return
  }

  await client.execute('BEGIN')
  try {
    await client.executeMultiple(migrationSql())
    await client.execute('COMMIT')
    console.log('[migration] Turso migration completed successfully.')
  } catch (err) {
    await client.execute('ROLLBACK')
    throw err
  }
}

async function migrateSqlite(dbPath) {
  const { default: Database } = await import('better-sqlite3')
  if (!fs.existsSync(dbPath)) {
    console.log(`[migration] SQLite database not found at ${dbPath}, nothing to migrate.`)
    return
  }

  const db = new Database(dbPath)
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'test_run_results'")
      .get()
    const schemaSql = String(row?.sql || '').toLowerCase()

    if (!schemaSql) {
      console.log('[migration] test_run_results table not found, nothing to migrate.')
      return
    }
    if (!schemaSql.includes('references test_cases')) {
      console.log('[migration] schema already up to date, nothing to migrate.')
      return
    }

    db.exec('BEGIN')
    db.exec(migrationSql())
    db.exec('COMMIT')
    console.log('[migration] SQLite migration completed successfully.')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw err
  } finally {
    db.close()
  }
}

async function main() {
  if (process.env.CONFIRM_DB_MIGRATION !== 'yes') {
    console.error(
      '[migration] Refusing to run. Set CONFIRM_DB_MIGRATION=yes to execute this manual migration.'
    )
    process.exit(1)
  }

  const { url, authToken } = libsqlEnv()
  if (url) {
    if (!authToken) {
      throw new Error('LIBSQL_AUTH_TOKEN (or TURSO_AUTH_TOKEN) is required when LIBSQL_URL is set')
    }
    await migrateTurso(url, authToken)
    return
  }

  const dbPath = resolveDatabasePath()
  await migrateSqlite(dbPath)
}

main().catch(err => {
  console.error('[migration] Failed:', err?.message || err)
  process.exit(1)
})
