import { CHAIN } from '@privacy-round-trip/shared'
import { MAX_VIEWING_KEY } from '@starkware-libs/starknet-privacy-sdk'
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

export interface SerializedEphemeralIdentity {
  address: string
  classHash: string
  salt: string
  publicKey: string
  privateKey: string
  viewingKey: string
}

function randomSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function createEphemeralIdentity(): EphemeralIdentity {
  const privateKey = normalizeHex(ec.starkCurve.grindKey(randomSeed()))
  const viewingKey = createViewingKey()
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

export function createViewingKey(): bigint {
  while (true) {
    const candidate = BigInt(normalizeHex(ec.starkCurve.grindKey(randomSeed())))
    if (isCanonicalViewingKey(candidate)) return candidate
  }
}

export function isCanonicalViewingKey(value: bigint): boolean {
  return value >= 1n && value <= MAX_VIEWING_KEY
}

export function restoreEphemeralIdentity(value: SerializedEphemeralIdentity): EphemeralIdentity {
  if (!/^0x[0-9a-fA-F]+$/.test(value.privateKey)) throw new Error('Recovery private key is invalid')
  const viewingKey = BigInt(value.viewingKey)
  if (!isCanonicalViewingKey(viewingKey)) throw new Error('Recovery viewing key is invalid')
  const publicKey = ec.starkCurve.getStarkKey(value.privateKey)
  if (BigInt(publicKey) !== BigInt(value.publicKey)) throw new Error('Recovery public key does not match')
  const address = hash.calculateContractAddressFromHash(value.salt, value.classHash, [publicKey], 0)
  if (BigInt(address) !== BigInt(value.address)) throw new Error('Recovery account address does not match')
  return {
    address,
    classHash: value.classHash,
    salt: value.salt,
    publicKey,
    privateKey: value.privateKey,
    viewingKey,
    signer: new Signer(value.privateKey),
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
