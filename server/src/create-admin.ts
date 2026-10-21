import { createDb } from './db'
import { hashPassword } from './password'

// Usage: npm run create-admin -- <email> <password>
const [email, password] = process.argv.slice(2)
if (!email?.includes('@') || !password || password.length < 8) {
  console.error('Usage: npm run create-admin -- <email> <password>  (password: at least 8 characters)')
  process.exit(1)
}

const db = createDb()
try {
  await db.query('INSERT INTO users (email, password_hash, role, must_change_password) VALUES (?, ?, ?, 0)', [
    email.trim().toLowerCase(),
    await hashPassword(password),
    'admin'
  ])
  console.log(`Admin ${email} created`)
} catch (err) {
  if ((err as { code?: string }).code !== 'ER_DUP_ENTRY') throw err
  console.error(`A user with email ${email} already exists`)
  process.exitCode = 1
} finally {
  await db.end()
}
