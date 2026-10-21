import { buildApp } from './app'
import { createDb } from './db'

const app = await buildApp(createDb(), true)
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3100) })
