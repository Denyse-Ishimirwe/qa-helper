import Database from 'better-sqlite3'

const db = new Database('qahelper.db')

db.exec(`

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
  form_url TEXT NOT NULL,
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
    snapshot_name TEXT NOT NULL,
    snapshot_what_to_test TEXT NOT NULL,
    snapshot_expected_result TEXT NOT NULL,
    snapshot_expected_outcome TEXT DEFAULT 'should_pass',
    snapshot_test_type TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (run_id) REFERENCES test_runs(id)
  );

 

`)


// Safe migration for existing databases: add test_type if missing.
try {
  db.exec(`ALTER TABLE test_cases ADD COLUMN test_type TEXT DEFAULT 'required_field'`)
} catch {}

try {
  db.exec(`ALTER TABLE test_cases ADD COLUMN expected_outcome TEXT DEFAULT 'should_pass'`)
} catch {}

try {
  db.exec(`ALTER TABLE test_cases ADD COLUMN notes TEXT`)
} catch {}

try {
  db.exec(`ALTER TABLE projects ADD COLUMN user_id INTEGER`)
} catch {}

try {
  db.exec(`ALTER TABLE projects ADD COLUMN form_structure TEXT`)
} catch {}

try {
  db.exec(`ALTER TABLE projects ADD COLUMN login_url TEXT`)
} catch {}

try {
  db.exec(`ALTER TABLE projects ADD COLUMN login_username TEXT`)
} catch {}

try {
  db.exec(`ALTER TABLE projects ADD COLUMN login_password TEXT`)
} catch {}

try {
  db.exec(`ALTER TABLE test_run_results ADD COLUMN snapshot_expected_outcome TEXT DEFAULT 'should_pass'`)
} catch {}

// Week 4 migration: remove test_case FK from historical run results.
// Regeneration deletes/recreates test_cases, so old run history must survive.
try {
  const tableSchema = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'test_run_results'"
  ).get()

  const schemaSql = (tableSchema?.sql || '').toLowerCase()
  const hasLegacyTestCaseFk = schemaSql.includes('references test_cases')

  if (hasLegacyTestCaseFk) {
    db.exec(`
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
    `)
  }
} catch (err) {
  console.error('test_run_results migration failed:', err.message)
}

try {
  db.prepare(
    'INSERT INTO users (email, password_hash) VALUES (?, ?)'
  ).run('QA_review_1@ymail.com', 'Try@123')
} catch {}

try {
  db.prepare(
    'INSERT INTO users (email, password_hash) VALUES (?, ?)'
  ).run('QA_review_2@ymail.com', 'Try@123')
} catch {}

try {
  db.prepare(
    'INSERT INTO users (email, password_hash) VALUES (?, ?)'
  ).run('QA_review_3@ymail.com', 'Try@123')
} catch {}

console.log('Database ready')

export default db