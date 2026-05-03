import 'dotenv/config'
import bcrypt from 'bcrypt'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function libsqlEnv() {
  const url = (process.env.LIBSQL_URL || process.env.TURSO_DATABASE_URL || '').trim()
  const authToken = (process.env.LIBSQL_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || '').trim()
  return { url, authToken }
}

function resolveDatabasePath() {
  if (process.env.DATABASE_PATH) {
    return path.resolve(process.env.DATABASE_PATH)
  }
  const localDefault = path.join(__dirname, 'qahelper.db')
  if (process.env.NODE_ENV !== 'production') {
    return localDefault
  }
  const dataRoot = '/data'
  try {
    if (!fs.existsSync(dataRoot)) {
      fs.mkdirSync(dataRoot, { recursive: true })
    }
    return path.join(dataRoot, 'qahelper.db')
  } catch (err) {
    console.error('Could not use /data for SQLite, falling back to app directory:', err?.message || err)
    return localDefault
  }
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
  );

 CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  name TEXT NOT NULL,
  form_url TEXT,
  login_url TEXT,
  login_username TEXT,
  login_password TEXT,
  form_structure TEXT,
  srd_text TEXT,
  status TEXT DEFAULT 'Not Tested',
  last_tested TEXT DEFAULT 'Never',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

  CREATE TABLE IF NOT EXISTS test_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    what_to_test TEXT NOT NULL,
    expected_result TEXT NOT NULL,
    generation_reason TEXT DEFAULT '',
    notes TEXT,
    expected_outcome TEXT DEFAULT 'should_pass',
    status TEXT DEFAULT 'Not Run',
    test_type TEXT DEFAULT 'required_field',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );
  CREATE TABLE IF NOT EXISTS test_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    run_started_at TEXT NOT NULL,
    run_finished_at TEXT NOT NULL,
    project_status TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS test_run_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    test_case_id INTEGER,
    status TEXT NOT NULL,
    notes TEXT,
    screenshot_path TEXT,
    snapshot_name TEXT NOT NULL,
    snapshot_what_to_test TEXT NOT NULL,
    snapshot_expected_result TEXT NOT NULL,
    snapshot_generation_reason TEXT DEFAULT '',
    snapshot_expected_outcome TEXT DEFAULT 'should_pass',
    snapshot_test_type TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (run_id) REFERENCES test_runs(id)
  );
`

function rowFromResultSet(r, index = 0) {
  if (!r?.rows?.length || index >= r.rows.length) return undefined
  const row = r.rows[index]
  const cols = r.columns
  const o = {}
  for (let i = 0; i < cols.length; i++) o[cols[i]] = row[i]
  return o
}

function rowsFromResultSet(r) {
  if (!r?.rows?.length) return []
  const cols = r.columns
  return r.rows.map(row => {
    const o = {}
    for (let i = 0; i < cols.length; i++) o[cols[i]] = row[i]
    return o
  })
}

let _sqlite = null
let _turso = null

async function tryExecTurso(sql) {
  try {
    await _turso.execute(sql)
  } catch {
    // duplicate column / already exists
  }
}

async function migrateTestRunResultsTurso() {
  const rs = await _turso.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'test_run_results'"
  )
  const tableSchema = rowFromResultSet(rs, 0)
  const schemaSql = String(tableSchema?.sql || '').toLowerCase()
  const hasLegacyTestCaseFk = schemaSql.includes('references test_cases')

  if (!hasLegacyTestCaseFk) return

  console.warn(
    '[qa-helper] Legacy test_run_results schema detected on Turso. Automatic table-rebuild migration is disabled at startup to avoid destructive changes.'
  )
}

function migrateTestRunResultsSqlite(db) {
  try {
    const tableSchema = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'test_run_results'")
      .get()

    const schemaSql = (tableSchema?.sql || '').toLowerCase()
    const hasLegacyTestCaseFk = schemaSql.includes('references test_cases')

    if (hasLegacyTestCaseFk) {
      console.warn(
        '[qa-helper] Legacy test_run_results schema detected in SQLite. Automatic table-rebuild migration is disabled at startup to avoid destructive changes.'
      )
    }
  } catch (err) {
    console.error('test_run_results migration failed:', err.message)
  }
}

async function seedUsersTurso() {
  const seeds = [
    ['QA_review_1@ymail.com', bcrypt.hashSync('Try@123', 10)],
    ['QA_review_2@ymail.com', bcrypt.hashSync('Try@123', 10)],
    ['QA_review_3@ymail.com', bcrypt.hashSync('Try@123', 10)]
  ]
  for (const [email, hash] of seeds) {
    const existing = await _turso.execute({
      sql: 'SELECT id FROM users WHERE email = ? LIMIT 1',
      args: [email]
    })
    if (rowFromResultSet(existing, 0)) continue

    await _turso.execute({
      sql: 'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      args: [email, hash]
    })
  }
}

async function initTurso(url, authToken) {
  const { createClient } = await import('@libsql/client')
  _turso = createClient({ url, authToken })
  await _turso.executeMultiple(SCHEMA_SQL)

  await tryExecTurso(`ALTER TABLE test_cases ADD COLUMN test_type TEXT DEFAULT 'required_field'`)
  await tryExecTurso(`ALTER TABLE test_cases ADD COLUMN expected_outcome TEXT DEFAULT 'should_pass'`)
  await tryExecTurso(`ALTER TABLE test_cases ADD COLUMN generation_reason TEXT DEFAULT ''`)
  await tryExecTurso(`ALTER TABLE test_cases ADD COLUMN notes TEXT DEFAULT ''`)
  await tryExecTurso(`ALTER TABLE projects ADD COLUMN user_id INTEGER`)
  await tryExecTurso(`ALTER TABLE projects ADD COLUMN form_structure TEXT`)
  await tryExecTurso(`ALTER TABLE projects ADD COLUMN login_url TEXT`)
  await tryExecTurso(`ALTER TABLE projects ADD COLUMN login_username TEXT`)
  await tryExecTurso(`ALTER TABLE projects ADD COLUMN login_password TEXT`)
  await tryExecTurso(`ALTER TABLE projects ADD COLUMN test_data_profile TEXT`)
  await tryExecTurso(
    `ALTER TABLE test_run_results ADD COLUMN snapshot_expected_outcome TEXT DEFAULT 'should_pass'`
  )
  await tryExecTurso(`ALTER TABLE test_run_results ADD COLUMN snapshot_generation_reason TEXT DEFAULT ''`)
  await tryExecTurso(`ALTER TABLE test_run_results ADD COLUMN screenshot_path TEXT`)

  try {
    await migrateTestRunResultsTurso()
  } catch (err) {
    console.error('test_run_results migration failed:', err.message)
  }

  await seedUsersTurso()
  console.log('[qa-helper] Database ready — Turso (remote SQLite; survives free-tier redeploys)')
}

async function initSqlite() {
  const { default: Database } = await import('better-sqlite3')
  const dbPath = resolveDatabasePath()
  const dbDir = path.dirname(dbPath)
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }

  if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_PATH && !libsqlEnv().url) {
    const onEphemeralAppDir =
      dbPath.startsWith(__dirname) || dbPath.includes(`${path.sep}app${path.sep}`)
    if (onEphemeralAppDir) {
      console.warn(
        '[qa-helper] SQLite is under the app folder — data will be lost on redeploy. Use Turso (LIBSQL_URL + LIBSQL_AUTH_TOKEN) for free hosted DB, or add a paid disk at /data.'
      )
    } else if (process.env.RENDER && dbPath.startsWith('/data')) {
      console.warn(
        '[qa-helper] SQLite path is /data/qahelper.db — confirm Render Disks mounts storage at mount path exactly /data.'
      )
    }
  }

  _sqlite = new Database(dbPath)
  _sqlite.exec(SCHEMA_SQL)

  try {
    _sqlite.exec(`ALTER TABLE test_cases ADD COLUMN test_type TEXT DEFAULT 'required_field'`)
  } catch {
    // Column already exists.
  }

  try {
    _sqlite.exec(`ALTER TABLE test_cases ADD COLUMN expected_outcome TEXT DEFAULT 'should_pass'`)
  } catch {
    // Column already exists.
  }

  try {
    _sqlite.exec(`ALTER TABLE test_cases ADD COLUMN generation_reason TEXT DEFAULT ''`)
  } catch {
    // Column already exists.
  }

  try {
    _sqlite.exec(`ALTER TABLE test_cases ADD COLUMN notes TEXT DEFAULT ''`)
  } catch {
    // Column already exists.
  }

  try {
    _sqlite.exec(`ALTER TABLE projects ADD COLUMN user_id INTEGER`)
  } catch {
    // Column already exists.
  }

  try {
    _sqlite.exec(`ALTER TABLE projects ADD COLUMN form_structure TEXT`)
  } catch {
    // Column already exists.
  }

  try {
    _sqlite.exec(`ALTER TABLE projects ADD COLUMN login_url TEXT`)
  } catch {
    // Column already exists.
  }

  try {
    _sqlite.exec(`ALTER TABLE projects ADD COLUMN login_username TEXT`)
  } catch {
    // Column already exists.
  }

  try {
    _sqlite.exec(`ALTER TABLE projects ADD COLUMN login_password TEXT`)
  } catch {
    // Column already exists.
  }

  try {
    _sqlite.exec(`ALTER TABLE projects ADD COLUMN test_data_profile TEXT`)
  } catch {
    // Column already exists.
  }

  try {
    _sqlite.exec(
      `ALTER TABLE test_run_results ADD COLUMN snapshot_expected_outcome TEXT DEFAULT 'should_pass'`
    )
  } catch {
    // Column already exists.
  }

  try {
    _sqlite.exec(`ALTER TABLE test_run_results ADD COLUMN snapshot_generation_reason TEXT DEFAULT ''`)
  } catch {
    // Column already exists.
  }

  try {
    _sqlite.exec(`ALTER TABLE test_run_results ADD COLUMN screenshot_path TEXT`)
  } catch {
    // Column already exists.
  }

  migrateTestRunResultsSqlite(_sqlite)

  for (const [email, hash] of [
    ['QA_review_1@ymail.com', bcrypt.hashSync('Try@123', 10)],
    ['QA_review_2@ymail.com', bcrypt.hashSync('Try@123', 10)],
    ['QA_review_3@ymail.com', bcrypt.hashSync('Try@123', 10)]
  ]) {
    const existing = _sqlite.prepare('SELECT id FROM users WHERE email = ? LIMIT 1').get(email)
    if (!existing) {
      _sqlite.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, hash)
    }
  }

  console.log('[qa-helper] Database ready at', dbPath)
}

export const dbReady = (async () => {
  const { url, authToken } = libsqlEnv()
  if (url) {
    if (!authToken) {
      console.error(
        '[qa-helper] LIBSQL_URL / TURSO_DATABASE_URL is set but LIBSQL_AUTH_TOKEN / TURSO_AUTH_TOKEN is missing — cannot connect to Turso.'
      )
      throw new Error('LIBSQL_AUTH_TOKEN (or TURSO_AUTH_TOKEN) is required when using a LibSQL URL')
    }
    await initTurso(url, authToken)
    return
  }
  await initSqlite()
})()

const db = {
  async get(sql, ...params) {
    await dbReady
    if (_sqlite) {
      return _sqlite.prepare(sql).get(...params)
    }
    const r = await _turso.execute({ sql, args: params })
    return rowFromResultSet(r, 0)
  },

  async all(sql, ...params) {
    await dbReady
    if (_sqlite) {
      return _sqlite.prepare(sql).all(...params)
    }
    const r = await _turso.execute({ sql, args: params })
    return rowsFromResultSet(r)
  },

  async run(sql, ...params) {
    await dbReady
    if (_sqlite) {
      const info = _sqlite.prepare(sql).run(...params)
      return { lastInsertRowid: info.lastInsertRowid, changes: info.changes }
    }
    const r = await _turso.execute({ sql, args: params })
    const lid = r.lastInsertRowid
    return {
      lastInsertRowid: lid === undefined ? 0 : Number(lid),
      changes: r.rowsAffected ?? 0
    }
  },

  async exec(sql) {
    await dbReady
    if (_sqlite) {
      return _sqlite.exec(sql)
    }
    await _turso.executeMultiple(sql)
  }
}

export default db
