import * as _ from 'lodash'
import { Bet } from './bet'
import { deductFixedFees } from './calculate-fixed-payouts'
import { Binary, CPMM, FullContract } from './contract'
import { CREATOR_FEE } from './fees'

export function getCpmmProbability(pool: { [outcome: string]: number }) {
  // For binary contracts only.
  const { YES, NO } = pool
  return NO / (YES + NO)
}

export function getCpmmOutcomeProbabilityAfterBet(
  contract: FullContract<CPMM, Binary>,
  outcome: string,
  bet: number
) {
  const { newPool } = calculateCpmmPurchase(contract, bet, outcome)
  const p = getCpmmProbability(newPool)
  return outcome === 'NO' ? 1 - p : p
}

export function calculateCpmmShares(
  pool: {
    [outcome: string]: number
  },
  bet: number,
  betChoice: string
) {
  const { YES: y, NO: n } = pool
  const k = y * n
  const numerator = bet ** 2 + bet * (y + n) - k + y * n
  const denominator = betChoice === 'YES' ? bet + n : bet + y
  const shares = numerator / denominator
  return shares
}

export function calculateCpmmPurchase(
  contract: FullContract<CPMM, Binary>,
  bet: number,
  outcome: string
) {
  const { pool } = contract

  const shares = calculateCpmmShares(pool, bet, outcome)
  const { YES: y, NO: n } = pool

  const [newY, newN] =
    outcome === 'YES'
      ? [y - shares + bet, n + bet]
      : [y + bet, n - shares + bet]

  const newPool = { YES: newY, NO: newN }

  return { shares, newPool }
}

export function calculateCpmmShareValue(
  contract: FullContract<CPMM, Binary>,
  shares: number,
  outcome: string
) {
  const { pool } = contract
  const { YES: y, NO: n } = pool

  const poolChange = outcome === 'YES' ? shares + y - n : shares + n - y
  const k = y * n
  const shareValue = 0.5 * (shares + y + n - Math.sqrt(4 * k + poolChange ** 2))
  return shareValue
}

export function calculateCpmmSale(
  contract: FullContract<CPMM, Binary>,
  bet: Bet
) {
  const { shares, outcome } = bet

  const saleValue = calculateCpmmShareValue(contract, shares, outcome)

  const { pool } = contract
  const { YES: y, NO: n } = pool

  const [newY, newN] =
    outcome === 'YES'
      ? [y + shares - saleValue, n - saleValue]
      : [y - saleValue, n + shares - saleValue]

  const newPool = { YES: newY, NO: newN }

  const profit = saleValue - bet.amount
  const creatorFee = CREATOR_FEE * Math.max(0, profit)
  const saleAmount = deductFixedFees(bet.amount, saleValue)

  return { saleValue, newPool, creatorFee, saleAmount }
}

export function getCpmmProbabilityAfterSale(
  contract: FullContract<CPMM, Binary>,
  bet: Bet
) {
  const { newPool } = calculateCpmmSale(contract, bet)
  return getCpmmProbability(newPool)
}

export const calcCpmmInitialPool = (initialProbInt: number, ante: number) => {
  const p = initialProbInt / 100.0

  const [poolYes, poolNo] =
    p >= 0.5 ? [ante * (1 / p - 1), ante] : [ante, ante * (1 / (1 - p) - 1)]

  return { poolYes, poolNo }
}

export function getCpmmLiquidity(pool: { [outcome: string]: number }) {
  // For binary contracts only.
  const { YES, NO } = pool
  return Math.sqrt(YES * NO)
}

export function addCpmmLiquidity(
  contract: FullContract<CPMM, Binary>,
  amount: number
) {
  const { YES, NO } = contract.pool
  const p = getCpmmProbability({ YES, NO })

  const [newYes, newNo] =
    p >= 0.5
      ? [amount * (1 / p - 1), amount]
      : [amount, amount * (1 / (1 - p) - 1)]

  const betAmount = Math.abs(newYes - newNo)
  const betOutcome = p >= 0.5 ? 'YES' : 'NO'

  const poolLiquidity = getCpmmLiquidity({ YES, NO })
  const newPool = { YES: YES + newYes, NO: NO + newNo }
  const resultingLiquidity = getCpmmLiquidity(newPool)
  const liquidity = resultingLiquidity - poolLiquidity

  return { newPool, liquidity, betAmount, betOutcome }
}

export function removeCpmmLiquidity(
  contract: FullContract<CPMM, Binary>,
  liquidity: number
) {
  const { YES, NO } = contract.pool
  const poolLiquidity = getCpmmLiquidity({ YES, NO })
  const p = getCpmmProbability({ YES, NO })

  const f = liquidity / poolLiquidity
  const [payoutYes, payoutNo] = [f * YES, f * NO]

  const betAmount = Math.abs(payoutYes - payoutNo)
  const betOutcome = p >= 0.5 ? 'NO' : 'YES' // opposite side as adding liquidity
  const payout = Math.min(payoutYes, payoutNo)

  const newPool = { YES: YES - payoutYes, NO: NO - payoutNo }

  return { newPool, payout, betAmount, betOutcome }
}
