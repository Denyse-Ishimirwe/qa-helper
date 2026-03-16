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
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );
`)

console.log('Database ready')

export default db