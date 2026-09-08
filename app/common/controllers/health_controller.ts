import { checkHealth } from '#common/services/health_check'
import { inject } from '@adonisjs/core'
import { HttpContext } from '@adonisjs/core/http'

/**
 * `GET /health` — the green light for the blue/green flip (`deploy.sh`) and for Docker's own probe.
 *
 * **200**: every mandatory dependency answers; the colour may take traffic.
 * **503**: at least one is silent — `deploy.sh` stops, Caddy never flips, and the previous colour
 * keeps serving. The body names each probe so a failure is diagnosed without opening a shell.
 *
 * Unauthenticated by design: it is called from `127.0.0.1` by a deploy script and by Docker, neither
 * of which carries a token. It discloses nothing but the up/down state of three dependencies.
 */
@inject()
export default class HealthController {
  async handle({ response }: HttpContext) {
    const report = await checkHealth()

    // A cached health response is a false one: the question is about *now*, and an intermediary
    // holding on to it would let the flip happen on a stale verdict.
    response.header('Cache-Control', 'no-store')

    return response.status(report.status === 'ok' ? 200 : 503).json(report)
  }
}
