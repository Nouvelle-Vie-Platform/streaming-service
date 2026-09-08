import env from '#start/env'
import { defineConfig } from '@adonisjs/redis'
import type { InferConnections } from '@adonisjs/redis/types'

/**
 * Redis holds the **volatile** side of a Transcode: the live progress percentage
 * (see CONTEXT.md, Q3). Only in-flight values live here; the durable lifecycle
 * is Postgres. The BullMQ queue keeps its own raw connection (config/queue.ts).
 */
const redisConfig = defineConfig({
  connection: 'main',

  connections: {
    main: {
      host: env.get('REDIS_HOST'),
      port: env.get('REDIS_PORT'),
      password: env.get('REDIS_PASSWORD', ''),
      // Shared host: keep in step with the portal's REDIS_DB (see start/env.ts).
      db: env.get('REDIS_DB', 0),
      keyPrefix: '',
      retryStrategy(times) {
        return times > 10 ? null : times * 50
      },
    },
  },
})

export default redisConfig

declare module '@adonisjs/redis/types' {
  export interface RedisConnections extends InferConnections<typeof redisConfig> {}
}
