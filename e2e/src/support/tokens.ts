import { CHAIN } from '@privacy-round-trip/shared'
import { createWalletClient, erc20Abi, http, type Address, type PublicClient } from 'viem'
import { mainnet } from 'viem/chains'
import { liveQuoteDependencies } from '../../../apps/api/src/quote.js'
import { publicClient, SWAP_ROUTER_ABI } from './ethereum.js'

/**
 * Buy `tokenOut` with ETH through the real Uniswap V3 SwapRouter on a fork. The router wraps ETH
 * itself when tokenIn is WETH9 and msg.value is supplied, so no whale impersonation or storage
 * surgery is needed to obtain USDC or WBTC. Returns the amount received.
 */
export async function buyWithEth(
  rpcUrl: string,
  buyer: Address,
  tokenOut: Address,
  ethIn: bigint,
): Promise<bigint> {
  const client = publicClient(rpcUrl)
  const wallet = createWalletClient({ account: buyer, chain: mainnet, transport: http(rpcUrl, { timeout: 60_000 }) })
  const { fee } = await liveQuoteDependencies(rpcUrl).quoteSwap(CHAIN.ethereum.tokens.WETH, tokenOut, ethIn)
  const before = await erc20Balance(client, tokenOut, buyer)
  const hash = await wallet.writeContract({
    address: CHAIN.ethereum.uniswap.swapRouter,
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: CHAIN.ethereum.tokens.WETH,
        tokenOut,
        fee,
        recipient: buyer,
        deadline: BigInt(Math.floor(Date.now() / 1_000) + 600),
        amountIn: ethIn,
        amountOutMinimum: 1n,
        sqrtPriceLimitX96: 0n,
      },
    ],
    value: ethIn,
  })
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Uniswap purchase of ${tokenOut} reverted`)
  return (await erc20Balance(client, tokenOut, buyer)) - before
}

export async function transferToken(
  rpcUrl: string,
  from: Address,
  token: Address,
  to: Address,
  amount: bigint,
): Promise<void> {
  const wallet = createWalletClient({ account: from, chain: mainnet, transport: http(rpcUrl, { timeout: 60_000 }) })
  const hash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [to, amount] })
  const receipt = await publicClient(rpcUrl).waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error('token transfer reverted')
}

export function erc20Balance(client: PublicClient, token: Address, owner: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
}
