import type { InjectOptions } from 'fastify'
import type { buildServer } from '../../../apps/api/src/server.js'

export type Api = Awaited<ReturnType<typeof buildServer>>

/** Issue an in-process request to the API and fail loudly on an unexpected status. */
export async function call<T = unknown>(app: Api, options: InjectOptions, expectedStatus: number): Promise<T> {
  const response = await app.inject(options)
  if (response.statusCode !== expectedStatus) {
    throw new Error(
      `${String(options.method ?? 'GET')} ${String(options.url)} returned ${response.statusCode}, expected ${expectedStatus}: ${response.body}`,
    )
  }
  return response.json() as T
}
