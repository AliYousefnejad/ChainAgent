import { buildApp } from './app'
import { createDb } from './db'

// TRUST_PROXY: the address(es) of the reverse proxy in front, e.g. 127.0.0.1 for nginx on this host.
// Only those hops are trusted, so clients can't fake their address with X-Forwarded-For.
// ("true" would trust every hop, and a hop count trusts none in this Fastify version.)
function trustedProxies(value = ''): string | false {
  if (!value || value === 'false') return false
  if (value === 'true' || /^\d+$/.test(value)) {
    console.warn('TRUST_PROXY must be the proxy address(es), e.g. 127.0.0.1. Ignoring it.')
    return false
  }
  return value
}

const app = await buildApp(createDb(), { logger: true, trustProxy: trustedProxies(process.env.TRUST_PROXY) })
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3100) })
