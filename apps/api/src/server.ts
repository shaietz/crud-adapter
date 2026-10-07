import { buildApp } from './app'

const port = Number(process.env.PORT ?? 3000)

const { fastify, seeded } = await buildApp({ logger: true })
await fastify.listen({ port, host: '127.0.0.1' })

fastify.log.info({ seeded }, 'seeded tenants')
fastify.log.info(`API on http://127.0.0.1:${port}/api — OpenAPI at /openapi.json`)
fastify.log.info(
  `Try: curl -H 'x-user-id: ${seeded.adminA}' -H 'x-org-id: ${seeded.orgA}' -H 'x-role: admin' http://127.0.0.1:${port}/api/users`,
)
