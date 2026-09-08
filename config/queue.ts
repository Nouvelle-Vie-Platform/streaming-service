import env from '#start/env'
import type { ConnectionOptions } from 'bullmq'

/**
 * Redis connection for the BullMQ transcode queue and worker.
 *
 * Passed as a plain options object (not a shared ioredis instance) so BullMQ
 * creates and tunes its own connections — in particular it forces
 * `maxRetriesPerRequest: null`, required by the worker's blocking reads.
 *
 * `@adonisjs/redis` and the volatile progress store land in jalon E (#5); the
 * queue only needs a raw connection for now.
 */
export const queueConnection: ConnectionOptions = {
  host: env.get('REDIS_HOST'),
  port: env.get('REDIS_PORT'),
  // Empty string in .env means "no auth" — don't send an empty AUTH.
  password: env.get('REDIS_PASSWORD') || undefined,
  // The queue lives in the same logical database as everything else this service writes; leaving
  // it on 0 while the rest moved would scatter a single service across two key spaces.
  db: env.get('REDIS_DB', 0),
}

/**
 * How many transcodes run in parallel per worker. Kept low by default: ffmpeg
 * with three renditions is CPU-heavy, and the queue is meant to hold the
 * backlog rather than starve the CPU (see the design, Q16).
 */
export const workerConcurrency = env.get('WORKER_CONCURRENCY', 1)
