import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'

// Load e2e/.env (or E2E_ENV_FILE) without overriding variables already present in the shell.
const envFile = process.env.E2E_ENV_FILE ?? fileURLToPath(new URL('../../.env', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)

// The browser API client reads its base URL from import.meta.env at module load. Point it at the
// API under test so the canary can reuse apps/web/src/starknet.ts unchanged.
if (process.env.E2E_API_URL) vi.stubEnv('VITE_API_URL', process.env.E2E_API_URL)
