// Measurement-only fallback for Python SQLite builds without SQLITE_ENABLE_DBSTAT_VTAB.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const rows = db.prepare('SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name').all();
  process.stdout.write(JSON.stringify(Object.fromEntries(rows.map(r => [r.name, r.bytes]))));
} finally {
  db.close();
}
