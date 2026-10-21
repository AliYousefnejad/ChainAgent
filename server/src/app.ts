import { createHash, randomBytes } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import type { Db } from './db'
import { hashPassword, verifyPassword } from './password'

type UserRow = RowDataPacket & {
  id: number
  email: string
  username: string | null
  password_hash: string
  role: 'admin' | 'user'
  must_change_password: number
  is_active: number
  created_at: Date
}

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow
    tokenHash: string
  }
}

const SESSION_DAYS = 30
const PASSWORD = { type: 'string', minLength: 8, maxLength: 200 } as const
const EMAIL = { type: 'string', format: 'email', maxLength: 255 } as const
const ID_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } as const

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const isDuplicate = (err: unknown) => (err as { code?: string }).code === 'ER_DUP_ENTRY'

const publicUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  username: u.username,
  role: u.role,
  mustChangePassword: Boolean(u.must_change_password)
})

const adminUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  username: u.username,
  role: u.role,
  active: Boolean(u.is_active),
  pendingSetup: Boolean(u.must_change_password),
  createdAt: u.created_at
})

export async function buildApp(db: Db, logger = false): Promise<FastifyInstance> {
  const app = Fastify({ logger })
  // Unknown emails are checked against this hash so both failures take the same time.
  const dummyHash = await hashPassword(randomBytes(16).toString('hex'))

  const findUser = async (where: string, value: unknown) => {
    const [rows] = await db.query<UserRow[]>(`SELECT * FROM users WHERE ${where} = ?`, [value])
    return rows[0]
  }

  async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return reply.code(401).send({ message: 'Unauthorized' })
    const tokenHash = sha256(header.slice(7))
    const [rows] = await db.query<UserRow[]>(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > NOW() AND u.is_active = 1`,
      [tokenHash]
    )
    if (!rows[0]) return reply.code(401).send({ message: 'Unauthorized' })
    req.user = rows[0]
    req.tokenHash = tokenHash
  }

  async function requireSetupDone(req: FastifyRequest, reply: FastifyReply) {
    if (req.user.must_change_password) {
      return reply.code(403).send({ message: 'Password change required', code: 'SETUP_REQUIRED' })
    }
  }

  async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
    if (req.user.role !== 'admin') return reply.code(403).send({ message: 'Admin only' })
  }

  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: { email: { type: 'string', maxLength: 255 }, password: { type: 'string', maxLength: 200 } }
        }
      }
    },
    async (req, reply) => {
      const user = await findUser('email', req.body.email.trim().toLowerCase())
      const valid = await verifyPassword(req.body.password, user?.password_hash ?? dummyHash)
      if (!user || !valid) return reply.code(401).send({ message: 'Invalid email or password' })
      if (!user.is_active) return reply.code(403).send({ message: 'Account disabled' })

      const token = randomBytes(32).toString('base64url')
      await db.query(
        'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, NOW() + INTERVAL ? DAY)',
        [user.id, sha256(token), SESSION_DAYS]
      )
      return { token, user: publicUser(user) }
    }
  )

  app.register(async (authed) => {
    authed.addHook('preHandler', requireAuth)

    authed.post('/auth/logout', async (req, reply) => {
      await db.query('DELETE FROM sessions WHERE token_hash = ?', [req.tokenHash])
      return reply.code(204).send()
    })

    authed.get('/me', async (req) => publicUser(req.user))

    authed.post<{ Body: { username: string; newPassword: string } }>(
      '/me/complete-setup',
      {
        schema: {
          body: {
            type: 'object',
            required: ['username', 'newPassword'],
            properties: { username: { type: 'string', pattern: '^[a-zA-Z0-9._-]{3,32}$' }, newPassword: PASSWORD }
          }
        }
      },
      async (req, reply) => {
        const { user } = req
        if (!user.must_change_password) return reply.code(400).send({ message: 'Account setup is already complete' })
        if (await verifyPassword(req.body.newPassword, user.password_hash)) {
          return reply.code(400).send({ message: 'New password must be different from the temporary password' })
        }
        try {
          await db.query('UPDATE users SET username = ?, password_hash = ?, must_change_password = 0 WHERE id = ?', [
            req.body.username.toLowerCase(),
            await hashPassword(req.body.newPassword),
            user.id
          ])
        } catch (err) {
          if (isDuplicate(err)) return reply.code(409).send({ message: 'Username is already taken' })
          throw err
        }
        return publicUser((await findUser('id', user.id))!)
      }
    )

    authed.register(
      async (admin) => {
        admin.addHook('preHandler', requireSetupDone)
        admin.addHook('preHandler', requireAdmin)

        admin.get('/users', async () => {
          const [rows] = await db.query<UserRow[]>('SELECT * FROM users ORDER BY created_at DESC, id DESC')
          return rows.map(adminUser)
        })

        admin.post<{ Body: { email: string; tempPassword: string } }>(
          '/users',
          {
            schema: {
              body: { type: 'object', required: ['email', 'tempPassword'], properties: { email: EMAIL, tempPassword: PASSWORD } }
            }
          },
          async (req, reply) => {
            try {
              const [result] = await db.query<ResultSetHeader>(
                'INSERT INTO users (email, password_hash, role, must_change_password) VALUES (?, ?, ?, 1)',
                [req.body.email.trim().toLowerCase(), await hashPassword(req.body.tempPassword), 'user']
              )
              return reply.code(201).send(adminUser((await findUser('id', result.insertId))!))
            } catch (err) {
              if (isDuplicate(err)) return reply.code(409).send({ message: 'A user with this email already exists' })
              throw err
            }
          }
        )

        admin.patch<{ Params: { id: number }; Body: { active: boolean } }>(
          '/users/:id/status',
          {
            schema: {
              params: ID_PARAMS,
              body: { type: 'object', required: ['active'], properties: { active: { type: 'boolean' } } }
            }
          },
          async (req, reply) => {
            const { id } = req.params
            if (id === req.user.id && !req.body.active) {
              return reply.code(400).send({ message: "You can't disable your own account" })
            }
            const [result] = await db.query<ResultSetHeader>('UPDATE users SET is_active = ? WHERE id = ?', [
              req.body.active ? 1 : 0,
              id
            ])
            if (!result.affectedRows) return reply.code(404).send({ message: 'User not found' })
            if (!req.body.active) await db.query('DELETE FROM sessions WHERE user_id = ?', [id])
            return adminUser((await findUser('id', id))!)
          }
        )

        admin.post<{ Params: { id: number }; Body: { tempPassword: string } }>(
          '/users/:id/reset-password',
          {
            schema: {
              params: ID_PARAMS,
              body: { type: 'object', required: ['tempPassword'], properties: { tempPassword: PASSWORD } }
            }
          },
          async (req, reply) => {
            const { id } = req.params
            const [result] = await db.query<ResultSetHeader>(
              'UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?',
              [await hashPassword(req.body.tempPassword), id]
            )
            if (!result.affectedRows) return reply.code(404).send({ message: 'User not found' })
            await db.query('DELETE FROM sessions WHERE user_id = ?', [id])
            return reply.code(204).send()
          }
        )
      },
      { prefix: '/admin' }
    )
  })

  return app
}
