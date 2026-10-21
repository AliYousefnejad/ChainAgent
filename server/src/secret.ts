import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// GitLab tokens are stored encrypted (AES-256-GCM) with CHAINAGENT_SECRET_KEY: 32 random bytes, base64.
function key(): Buffer {
  const value = Buffer.from(process.env.CHAINAGENT_SECRET_KEY ?? '', 'base64')
  if (value.length !== 32) throw new Error('Set CHAINAGENT_SECRET_KEY (32 random bytes, base64) to store GitLab tokens.')
  return value
}

export function encrypt(text: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.')
}

export function decrypt(stored: string): string {
  const [iv, tag, data] = stored.split('.').map((part) => Buffer.from(part, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
