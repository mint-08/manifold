import * as functions from 'firebase-functions'
import { groupBy, sum, uniq, zipObject } from 'lodash'

import { isProd, log, revalidateStaticProps } from 'shared/utils'
import { Bet } from 'common/bet'
import { Contract } from 'common/contract'
import {
  SupabaseDirectClient,
  createSupabaseDirectClient,
} from 'shared/supabase/init'
import { bulkUpdate } from 'shared/supabase/utils'
import { secrets } from 'common/secrets'
import { CURRENT_SEASON, getSeasonDates } from 'common/leagues'
import { getProfitMetrics } from 'common/calculate'

export const updateLeague = functions
  .runWith({
    memory: isProd() ? '4GB' : '256MB',
    timeoutSeconds: 540,
    secrets,
  })
  .pubsub.schedule('every 15 minutes')
  .onRun(async () => {
    await updateLeagueCore()
  })

export async function updateLeagueCore() {
  const pg = createSupabaseDirectClient()

  const season = CURRENT_SEASON
  const { start, end } = getSeasonDates(season)
  const seasonStart = start.getTime()
  const seasonEnd = end.getTime()

  if (Date.now() > seasonEnd) {
    log('Season has ended. Exiting.')
    return
  }

  log('Loading users...')
  const userIds = await pg.map(
    `select id from users
    join leagues on leagues.user_id = users.id
    where leagues.season = $1`,
    [season],
    (r) => r.id as string
  )
  log(`Loaded ${userIds.length} user ids.`)

  log('Loading txns...')
  const txnCategoriesCountedAsManaEarned = [
    'BETTING_STREAK_BONUS',
    'AD_REDEEM',
    'MARKET_BOOST_REDEEM',
    'QUEST_REWARD',
    'REFERRAL',
  ]
  const txnData = await pg.manyOrNone<{
    user_id: string
    category: string
    amount: number
  }>(
    `select
      user_id,
      category,
      sum(amount) as amount
    from txns
    join
      leagues on leagues.user_id = txns.to_id
    where
      leagues.season = $1
      and txns.created_time > millis_to_ts($2)
      and txns.created_time < millis_to_ts($3)
      and txns.category in ($4:csv)
    group by user_id, category
    `,
    [season, seasonStart, seasonEnd, txnCategoriesCountedAsManaEarned]
  )

  // Unique bettor bonuses during the season (contract can be created any time).
  const uniqueBettorBonuses = await pg.manyOrNone<{
    user_id: string
    category: string
    amount: number
  }>(
    `select
      user_id,
      category,
      sum(amount) as amount
    from txns 
    join
      leagues on leagues.user_id = txns.to_id
    where
      leagues.season = $1
      and txns.created_time > millis_to_ts($2)
      and txns.created_time < millis_to_ts($3)
      and txns.category = 'UNIQUE_BETTOR_BONUS'
    group by user_id, category
    `,
    [season, seasonStart, seasonEnd]
  )

  const negativeBettorBonuses = await pg.manyOrNone<{
    user_id: string
    category: string
    amount: number
  }>(
    `select
      user_id,
      category,
      -1 * sum(amount) as amount
    from txns 
    join
      leagues on leagues.user_id = txns.from_id
    join
      contracts on contracts.id = txns.data->'data'->>'contractId'
    where
      leagues.season = $1
      and ts_to_millis(contracts.created_time) > $2
      and ts_to_millis(contracts.created_time) < $3
      and txns.created_time > millis_to_ts($2)
      and txns.created_time < millis_to_ts($3)
      and txns.category = 'CANCEL_UNIQUE_BETTOR_BONUS'
    group by user_id, category
    `,
    [season, seasonStart, seasonEnd]
  )

  console.log(
    'Loaded txns per user',
    txnData.length,
    'unique bettor bonuses',
    uniqueBettorBonuses.length,
    'negative bettor bonuses',
    negativeBettorBonuses.length
  )

  log('Loading bets...')
  const betData = await pg.manyOrNone<{ data: Bet }>(
    `select cb.data
    from
      contract_bets as cb
    where
      created_time > millis_to_ts($1)
      and created_time < millis_to_ts($2)
    `,
    [seasonStart, seasonEnd]
  )
  const bets = betData.map((b) => b.data)
  const betsByUserId = groupBy(bets, (b) => b.userId)
  log(`Loaded ${bets.length} bets.`)

  log('Loading contracts...')
  const contracts = await getRelevantContracts(pg, bets)
  const contractsById = Object.fromEntries(contracts.map((c) => [c.id, c]))

  log(`Loaded ${contracts.length} contracts.`)

  log('Computing metric updates...')
  const userProfit: { user_id: string; amount: number; category: 'profit' }[] =
    []
  for (const userId of userIds) {
    const userBets = betsByUserId[userId] ?? []
    const betsByContract = groupBy(userBets, (b) => b.contractId)
    let totalProfit = 0

    for (const [contractId, contractBets] of Object.entries(betsByContract)) {
      const contract = contractsById[contractId]
      if (
        contract &&
        contract.visibility === 'public' &&
        contract.isRanked !== false &&
        !EXCLUDED_CONTRACT_SLUGS.has(contract.slug)
      ) {
        const { profit } = getProfitMetrics(contract, contractBets)
        if (isNaN(profit)) {
          console.error(
            'Profit is NaN! contract',
            contract.slug,
            contract.id,
            'userId',
            userId
          )
          continue
        }

        totalProfit += profit
      }
    }
    userProfit.push({
      user_id: userId,
      amount: totalProfit,
      category: 'profit',
    })
  }

  const amountByUserId = groupBy(
    [
      ...userProfit,
      ...txnData,
      ...uniqueBettorBonuses,
      ...negativeBettorBonuses,
    ].map((u) => ({ ...u, amount: +u.amount })),
    'user_id'
  )

  // Set Genzy's referral mana to 0.
  const GENZY_USER_ID = 'cA1JupYR5AR8btHUs2xvkui7jA93'
  const genzyManaEarned = amountByUserId[GENZY_USER_ID]
  if (genzyManaEarned) {
    genzyManaEarned
      .filter((a) => a.category === 'REFERRAL')
      .forEach((a) => (a.amount = 0))
  }

  const manaEarnedUpdates = []
  for (const [userId, manaEarned] of Object.entries(amountByUserId)) {
    const keys = manaEarned.map((a) => a.category)
    const amounts = manaEarned.map((a) => a.amount)
    const manaEarnedBreakdown = zipObject(keys, amounts)
    const total = sum(amounts)

    manaEarnedUpdates.push({
      user_id: userId,
      season,
      mana_earned: total,
      mana_earned_breakdown: `${JSON.stringify(manaEarnedBreakdown)}::jsonb`,
    })
  }

  console.log('Mana earned updates', manaEarnedUpdates.length)

  await bulkUpdate(pg, 'leagues', ['user_id', 'season'], manaEarnedUpdates)
  await revalidateStaticProps('/leagues')
  log('Done.')
}

const getRelevantContracts = async (pg: SupabaseDirectClient, bets: Bet[]) => {
  const betContractIds = uniq(bets.map((b) => b.contractId))
  return await pg.map(
    `select data from contracts where id in ($1:list)`,
    [betContractIds],
    (r) => r.data as Contract
  )
}

const EXCLUDED_CONTRACT_SLUGS = new Set([
  'will-there-be-another-wellrecognize-393de260ec26',
  'will-there-be-another-wellrecognize-511a499bd82e',
  'will-there-be-another-wellrecognize',
])
