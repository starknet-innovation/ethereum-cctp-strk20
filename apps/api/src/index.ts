import { loadConfig } from './config.js'
import { buildServer } from './server.js'

const config = loadConfig()
const app = await buildServer(config)

try {
  await app.listen({ host: config.HOST, port: config.PORT })
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
}
