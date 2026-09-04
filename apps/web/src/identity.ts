import { CHAIN } from '@privacy-round-trip/shared'
import { ec, hash, num, Signer, type SignerInterface } from 'starknet'

export interface EphemeralIdentity {
  address: string
  classHash: string
  salt: string
  publicKey: string
  privateKey: string
  viewingKey: bigint
  signer: SignerInterface
}

function randomSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function createEphemeralIdentity(): EphemeralIdentity {
  const privateKey = normalizeHex(ec.starkCurve.grindKey(randomSeed()))
  const viewingKey = BigInt(normalizeHex(ec.starkCurve.grindKey(randomSeed())))
  const publicKey = ec.starkCurve.getStarkKey(privateKey)
  const salt = num.toHex(publicKey)
  const classHash = CHAIN.starknet.ozAccountClassHash
  const address = hash.calculateContractAddressFromHash(salt, classHash, [publicKey], 0)
  return {
    address,
    classHash,
    salt,
    publicKey,
    privateKey,
    viewingKey,
    signer: new Signer(privateKey),
  }
}

export function clearIdentity(identity: EphemeralIdentity | undefined): void {
  if (!identity) return
  identity.privateKey = ''
  identity.viewingKey = 0n
}

function normalizeHex(value: string): string {
  return value.startsWith('0x') ? value : `0x${value}`
}
