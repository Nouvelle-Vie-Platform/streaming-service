import { rustfsBucket, rustfsClient } from '#config/rustfs'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import { HeadBucketCommand } from '@aws-sdk/client-s3'

/**
 * **The blue/green readiness probe** — the single signal that lets `deploy.sh` move traffic onto a
 * freshly started colour.
 *
 * ## Why not `/ping` or `/`
 *
 * Both answer from memory. A container booted with a wrong database password, an unreachable Redis
 * or a mistyped RustFS key answers them perfectly — so flipping on that signal proves only that the
 * process started. This probe instead exercises every dependency the env schema declares
 * **mandatory**, because those are the ones with no degraded mode.
 *
 * ## Why RustFS is probed here but not in the portal
 *
 * The portal treats its media store as optional (a missing store yields a 503 on deposit and
 * nothing else). Here it is required: every transcode ends by pushing HLS, download renditions and
 * the FLAC archive to it. A bad credential would let the flip succeed and then fail *every* job
 * silently, one retry cycle at a time — exactly the failure blue/green exists to prevent.
 * `HeadBucket` is a single request against a loopback endpoint; the cost is irrelevant.
 *
 * The queue is deliberately *not* probed: a reachable Redis is what BullMQ needs, and an empty or
 * backed-up queue is a healthy state, not a broken one.
 */

const PROBE_TIMEOUT_MS = 3_000

export type ProbeState = 'ok' | 'ko'

export interface HealthReport {
  status: ProbeState
  checks: Record<'database' | 'redis' | 'rustfs', { state: ProbeState; error?: string }>
}

/**
 * Bounds a probe in time. Without it a dependency that accepts the TCP connection and then never
 * answers (saturated host, dropped packets) leaves the probe hanging — and Docker keeps reporting
 * the container healthy for as long as the check has not returned a verdict.
 */
async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timed out`)), PROBE_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const PROBES = {
  database: () => withTimeout(db.rawQuery('select 1'), 'postgres'),
  redis: () => withTimeout(redis.ping(), 'redis'),
  rustfs: () =>
    withTimeout(rustfsClient.send(new HeadBucketCommand({ Bucket: rustfsBucket })), 'rustfs'),
} as const

/**
 * Runs every probe **in parallel** and reports them all: one request must be enough to know what is
 * broken, otherwise diagnosis becomes a serial guessing game at three in the morning.
 */
export async function checkHealth(): Promise<HealthReport> {
  const names = Object.keys(PROBES) as (keyof typeof PROBES)[]

  const results = await Promise.all(
    names.map(async (name) => {
      try {
        await PROBES[name]()
        return [name, { state: 'ok' as const }] as const
      } catch (error) {
        return [name, { state: 'ko' as const, error: (error as Error).message }] as const
      }
    })
  )

  const checks = Object.fromEntries(results) as HealthReport['checks']
  const status = results.every(([, r]) => r.state === 'ok') ? 'ok' : 'ko'

  return { status, checks }
}
