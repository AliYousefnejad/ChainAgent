import { createHash, randomBytes } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import type { Db } from './db'
import { insightRoutes } from './insights'
import { createLoginLimiter, type LoginLimiter } from './login-limiter'
import { projectRoutes } from './projects'
import { hashPassword, verifyPassword } from './password'

type UserRow = RowDataPacket & {
  id: number
  email: string
  username: string | null
  password_hash: string
  role: Role
  must_change_password: number
  is_active: number
  gitlab_username: string | null
  git_emails: string[] | null
  created_at: Date
  failed_logins: number
  locked_until: Date | null
  lock_seconds: number | null // seconds left on a lock, computed by MySQL
}

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow
    tokenHash: string
  }
}

export type Role = 'admin' | 'manager' | 'user'
const ROLES: Role[] = ['admin', 'manager', 'user']

const SESSION_DAYS = 30
const MAX_WRONG_PASSWORDS = 5
const LOCK_MINUTES = 15
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
  lockedUntil: u.lock_seconds ? u.locked_until : null,
  gitlabUsername: u.gitlab_username,
  gitEmails: u.git_emails ?? [],
  createdAt: u.created_at
})

type Options = { logger?: boolean; trustProxy?: string | false; limiter?: LoginLimiter }

const USER_COLUMNS = '*, GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), locked_until)) AS lock_seconds'

export async function buildApp(db: Db, { logger = false, trustProxy = false, limiter = createLoginLimiter() }: Options = {}): Promise<FastifyInstance> {
  // trustProxy: the proxy addresses in front (e.g. '127.0.0.1'), so req.ip is the real client.
  const options: FastifyServerOptions = { logger, trustProxy }
  const app = Fastify(options)

  const findUser = async (where: string, value: unknown) => {
    const [rows] = await db.query<UserRow[]>(`SELECT ${USER_COLUMNS} FROM users WHERE ${where} = ?`, [value])
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

  const requireRole =
    (...roles: Role[]) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!roles.includes(req.user.role)) return reply.code(403).send({ message: 'Not allowed for your role' })
    }

  // Admins manage everyone; managers manage members only.
  const canManage = (actor: UserRow, target: UserRow) => actor.role === 'admin' || target.role === 'user'

  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: { email: EMAIL, password: { type: 'string', maxLength: 200 } }
        }
      }
    },
    async (req, reply) => {
      // Each try is booked before the slow password check, so parallel requests can't slip past
      // either limit. Too many from one address also stops guessing which emails have accounts.
      if (!limiter.attempt(req.ip)) {
        return reply.code(429).send({ message: 'Too many failed sign-in attempts from this network. Try again later.' })
      }
      // Accounts are admin-created, so login says plainly whether the email is registered.
      const user = await findUser('email', req.body.email.trim().toLowerCase())
      if (!user) return reply.code(401).send({ message: 'No account found for this email. Ask your admin to add you.' })

      // Book a try on the account in one statement; a locked account books nothing and is refused,
      // even with the right password. The try that reaches the limit starts the lock.
      const [booked] = await db.query<ResultSetHeader>(
        `UPDATE users SET locked_until = IF(failed_logins + 1 >= ?, NOW() + INTERVAL ? MINUTE, NULL),
           failed_logins = IF(failed_logins + 1 >= ?, 0, failed_logins + 1)
         WHERE id = ? AND (locked_until IS NULL OR locked_until <= NOW())`,
        [MAX_WRONG_PASSWORDS, LOCK_MINUTES, MAX_WRONG_PASSWORDS, user.id]
      )
      const locked = (u: UserRow) => {
        const minutes = Math.ceil((u.lock_seconds || LOCK_MINUTES * 60) / 60)
        return reply
          .code(429)
          .send({ message: `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'} or ask your admin.` })
      }
      if (!booked.affectedRows) return locked(user)

      if (!(await verifyPassword(req.body.password, user.password_hash))) {
        const now = (await findUser('id', user.id))!
        if (now.lock_seconds) return locked(now)
        const left = MAX_WRONG_PASSWORDS - now.failed_logins
        const warning = left <= 2 ? `. ${left} ${left === 1 ? 'try' : 'tries'} left before a ${LOCK_MINUTES}-minute lock.` : ''
        return reply.code(401).send({ message: `Wrong password${warning}` })
      }

      // Right password: give back this try's bookings and clear the account's count.
      limiter.undo(req.ip)
      await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [user.id])
      if (!user.is_active) return reply.code(403).send({ message: 'Account disabled. Ask your admin to enable it.' })

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

    authed.post<{ Body: { currentPassword: string; newPassword: string } }>(
      '/me/password',
      {
        preHandler: requireSetupDone,
        schema: {
          body: {
            type: 'object',
            required: ['currentPassword', 'newPassword'],
            properties: { currentPassword: { type: 'string', maxLength: 200 }, newPassword: PASSWORD }
          }
        }
      },
      async (req, reply) => {
        const { user } = req
        if (!(await verifyPassword(req.body.currentPassword, user.password_hash))) {
          return reply.code(400).send({ message: 'Current password is wrong' })
        }
        if (req.body.newPassword === req.body.currentPassword) {
          return reply.code(400).send({ message: 'New password must be different from the current one' })
        }
        await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(req.body.newPassword), user.id])
        // Sign out everywhere else; this session stays.
        await db.query('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [user.id, req.tokenHash])
        return reply.code(204).send()
      }
    )

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
        admin.addHook('preHandler', requireRole('admin', 'manager'))

        admin.get('/users', async () => {
          const [rows] = await db.query<UserRow[]>(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at DESC, id DESC`)
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
            const target = await findUser('id', id)
            if (!target) return reply.code(404).send({ message: 'User not found' })
            if (!canManage(req.user, target)) return reply.code(403).send({ message: 'Managers can only manage members' })
            await db.query('UPDATE users SET is_active = ? WHERE id = ?', [req.body.active ? 1 : 0, id])
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
            const target = await findUser('id', id)
            if (!target) return reply.code(404).send({ message: 'User not found' })
            if (!canManage(req.user, target)) return reply.code(403).send({ message: 'Managers can only manage members' })
            await db.query(
              'UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?',
              [await hashPassword(req.body.tempPassword), id]
            )
            await db.query('DELETE FROM sessions WHERE user_id = ?', [id])
            return reply.code(204).send()
          }
        )

        admin.patch<{ Params: { id: number }; Body: { role: Role } }>(
          '/users/:id/role',
          {
            preHandler: requireRole('admin'),
            schema: {
              params: ID_PARAMS,
              body: { type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ROLES } } }
            }
          },
          async (req, reply) => {
            const { id } = req.params
            if (id === req.user.id) return reply.code(400).send({ message: "You can't change your own role" })
            const [result] = await db.query<ResultSetHeader>('UPDATE users SET role = ? WHERE id = ?', [req.body.role, id])
            if (!result.affectedRows) return reply.code(404).send({ message: 'User not found' })
            return adminUser((await findUser('id', id))!)
          }
        )

        // Links a person to their GitLab account and the emails their commits use.
        admin.patch<{ Params: { id: number }; Body: { gitlabUsername: string | null; gitEmails: string[] } }>(
          '/users/:id/identity',
          {
            schema: {
              params: ID_PARAMS,
              body: {
                type: 'object',
                required: ['gitlabUsername', 'gitEmails'],
                properties: {
                  gitlabUsername: { type: ['string', 'null'], maxLength: 255 },
                  gitEmails: { type: 'array', maxItems: 20, items: EMAIL }
                }
              }
            }
          },
          async (req, reply) => {
            const { id } = req.params
            const target = await findUser('id', id)
            if (!target) return reply.code(404).send({ message: 'User not found' })
            if (!canManage(req.user, target)) return reply.code(403).send({ message: 'Managers can only manage members' })
            const username = req.body.gitlabUsername?.trim().replace(/^@/, '') || null
            const emails = [...new Set(req.body.gitEmails.map((e) => e.trim().toLowerCase()))]
            await db.query('UPDATE users SET gitlab_username = ?, git_emails = ? WHERE id = ?', [username, JSON.stringify(emails), id])
            return adminUser((await findUser('id', id))!)
          }
        )
      },
      { prefix: '/admin' }
    )

    authed.register(projectRoutes(db, [requireSetupDone, requireRole('admin', 'manager')]), { prefix: '/projects' })
    authed.register(insightRoutes(db, [requireSetupDone]), { prefix: '/insights' })
  })

  return app
}
