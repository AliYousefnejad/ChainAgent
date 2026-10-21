import mysql from 'mysql2/promise'

export type Db = mysql.Pool

// Everything is in UTC: MySQL's NOW() and the driver's reading of DATETIME columns, so times
// from GitLab and from MySQL mean the same instant whatever the server's time zone is.
export function createDb(): Db {
  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: 'Z'
  })
  pool.pool.on('connection', (connection) => connection.query("SET time_zone = '+00:00'"))
  return pool
}
