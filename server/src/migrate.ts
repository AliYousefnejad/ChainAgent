import { readdir, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { RowDataPacket } from 'mysql2'
import { createDb, type Db } from './db'

const SQL_DIR = new URL('../sql/', import.meta.url)

// Runs every sql/*.sql file once, in name order.
export async function migrate(db: Db): Promise<void> {
  await db.query(
    'CREATE TABLE IF NOT EXISTS migrations (name VARCHAR(255) PRIMARY KEY, ran_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)'
  )
  const [rows] = await db.query<RowDataPacket[]>('SELECT name FROM migrations')
  const done = new Set(rows.map((r) => r.name))

  const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    if (done.has(file)) continue
    const sql = await readFile(new URL(file, SQL_DIR), 'utf8')
    for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      await db.query(statement)
    }
    await db.query('INSERT INTO migrations (name) VALUES (?)', [file])
    console.log(`migrated ${file}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = createDb()
  await migrate(db)
  await db.end()
}
