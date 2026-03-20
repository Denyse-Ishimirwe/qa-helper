import Database from 'better-sqlite3'

const db = new Database('qahelper.db')

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    form_url TEXT NOT NULL,
    srd_text TEXT,
    status TEXT DEFAULT 'Not Tested',
    last_tested TEXT DEFAULT 'Never',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS test_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    what_to_test TEXT NOT NULL,
    expected_result TEXT NOT NULL,
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
    snapshot_test_type TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (run_id) REFERENCES test_runs(id)
  );

`)


// Safe migration for existing databases: add test_type if missing.
try {
  db.exec(`ALTER TABLE test_cases ADD COLUMN test_type TEXT DEFAULT 'required_field'`)
} catch {
  // Column already exists — ignore
}

// Week 4 migration: remove test_case FK from historical run results.
// Regeneration deletes/recreates test_cases, so old run history must survive.
try {
  const fkList = db.prepare(`PRAGMA foreign_key_list('test_run_results')`).all()
  const hasTestCaseFk = fkList.some(fk => fk.table === 'test_cases')

  if (hasTestCaseFk) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_run_results_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        test_case_id INTEGER,
        status TEXT NOT NULL,
        notes TEXT,
        snapshot_name TEXT NOT NULL,
        snapshot_what_to_test TEXT NOT NULL,
        snapshot_expected_result TEXT NOT NULL,
        snapshot_test_type TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (run_id) REFERENCES test_runs(id)
      );

      INSERT INTO test_run_results_new (
        id, run_id, test_case_id, status, notes,
        snapshot_name, snapshot_what_to_test, snapshot_expected_result, snapshot_test_type, created_at
      )
      SELECT
        id, run_id, test_case_id, status, notes,
        snapshot_name, snapshot_what_to_test, snapshot_expected_result, snapshot_test_type, created_at
      FROM test_run_results;

      DROP TABLE test_run_results;
      ALTER TABLE test_run_results_new RENAME TO test_run_results;
    `)
  }
} catch (err) {
  console.error('test_run_results migration failed:', err.message)
}

console.log('Database ready')

export default db