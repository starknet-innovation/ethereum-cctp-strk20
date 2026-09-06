import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Abi, Hex } from 'viem'

export const EVM_ROOT = fileURLToPath(new URL('../../../contracts/evm/', import.meta.url))

export type ContractName = 'PrivacyEntryRouter' | 'ExitSettlementFactory' | 'ExitSettlement'

export interface Artifact {
  abi: Abi
  bytecode: Hex
}

export function forgeAvailable(): boolean {
  try {
    execFileSync('forge', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let built = false

/** Compile contracts/evm once per process (incremental, cheap) and read a Foundry artifact. */
export function loadArtifact(name: ContractName): Artifact {
  const path = `${EVM_ROOT}out/${name}.sol/${name}.json`
  if (!built) {
    if (forgeAvailable()) {
      execFileSync('forge', ['build', '--root', EVM_ROOT], { stdio: 'ignore' })
      built = true
    } else if (!existsSync(path)) {
      throw new Error(`Foundry artifact ${path} is missing and forge is not installed`)
    }
  }
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as { abi: Abi; bytecode: { object: Hex } }
  return { abi: artifact.abi, bytecode: artifact.bytecode.object }
}
