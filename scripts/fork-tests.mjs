#!/usr/bin/env node
// forge does not read e2e/.env, but the README quickstart puts ETHEREUM_RPC_URL there — without
// this wrapper the fork suite skipped every test while still reporting success. npm launches it
// with --env-file-if-exists, so Node loads that file (already-exported shell variables keep
// precedence) before handing off to forge. Extra arguments are passed through.
import { spawnSync } from 'node:child_process'

const args = [
  'test',
  '--root',
  'contracts/evm',
  '--match-path',
  'test/fork/*',
  '-vv',
  ...process.argv.slice(2),
]
const result = spawnSync('forge', args, { stdio: 'inherit' })
if (result.error) {
  console.error(
    result.error.code === 'ENOENT'
      ? 'forge was not found on PATH. Install Foundry (https://getfoundry.sh) to run the fork suite.'
      : result.error.message,
  )
  process.exit(1)
}
process.exit(result.status ?? 1)
