import router from '@adonisjs/core/services/router'

const EchoController = () => import('#common/controllers/echo_controller')
const PinController = () => import('#common/controllers/ping_controller')
const HealthController = () => import('#common/controllers/health_controller')

router.group(() => {
  // Deployment probe: actually exercises Postgres, Redis and RustFS, unlike `/ping` which only
  // proves the process is up. This is what authorises the blue/green flip.
  router.get('/health', [HealthController]).as('health')

  router.get('/ping', [PinController]).as('ping.get')
  router.post('/ping', [PinController]).as('ping.post')
  router.post('/echo', [EchoController]).as('echo')
})
