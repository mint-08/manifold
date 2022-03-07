import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'

import { chargeUser, getUser } from './utils'
import {
  Binary,
  Contract,
  CPMM,
  DPM,
  FreeResponse,
  FullContract,
  outcomeType,
} from '../../common/contract'
import { slugify } from '../../common/util/slugify'
import { randomString } from '../../common/util/random'
import { getNewContract } from '../../common/new-contract'
import {
  getAnteBets,
  getCpmmAnteBet,
  getCpmmInitialLiquidity,
  getFreeAnswerAnte,
  MINIMUM_ANTE,
} from '../../common/antes'
import { getNoneAnswer } from '../../common/answer'

export const createContract = functions
  .runWith({ minInstances: 1 })
  .https.onCall(
    async (
      data: {
        question: string
        outcomeType: outcomeType
        description: string
        initialProb: number
        ante: number
        closeTime: number
        tags?: string[]
      },
      context
    ) => {
      const userId = context?.auth?.uid
      if (!userId) return { status: 'error', message: 'Not authorized' }

      const creator = await getUser(userId)
      if (!creator) return { status: 'error', message: 'User not found' }

      const { question, description, initialProb, ante, closeTime, tags } = data

      if (!question)
        return { status: 'error', message: 'Missing question field' }

      let outcomeType = data.outcomeType ?? 'BINARY'
      if (!['BINARY', 'MULTI', 'FREE_RESPONSE'].includes(outcomeType))
        return { status: 'error', message: 'Invalid outcomeType' }

      if (
        outcomeType === 'BINARY' &&
        (!initialProb || initialProb < 1 || initialProb > 99)
      )
        return { status: 'error', message: 'Invalid initial probability' }

      if (
        ante === undefined ||
        ante < MINIMUM_ANTE ||
        ante > creator.balance ||
        isNaN(ante) ||
        !isFinite(ante)
      )
        return { status: 'error', message: 'Invalid ante' }

      console.log(
        'creating contract for',
        creator.username,
        'on',
        question,
        'ante:',
        ante || 0
      )

      const slug = await getSlug(question)

      const contractRef = firestore.collection('contracts').doc()

      const contract = getNewContract(
        contractRef.id,
        slug,
        creator,
        question,
        outcomeType,
        description,
        initialProb,
        ante,
        closeTime,
        tags ?? []
      )

      if (ante) await chargeUser(creator.id, ante)

      await contractRef.create(contract)

      if (ante) {
        if (outcomeType === 'BINARY' && contract.mechanism === 'dpm-2') {
          const yesBetDoc = firestore
            .collection(`contracts/${contract.id}/bets`)
            .doc()

          const noBetDoc = firestore
            .collection(`contracts/${contract.id}/bets`)
            .doc()

          const { yesBet, noBet } = getAnteBets(
            creator,
            contract as FullContract<DPM, Binary>,
            yesBetDoc.id,
            noBetDoc.id
          )

          await yesBetDoc.set(yesBet)
          await noBetDoc.set(noBet)
        } else if (outcomeType === 'BINARY') {
          const { YES: y, NO: n } = contract.pool
          const anteBet = Math.abs(y - n)

          if (anteBet) {
            const betDoc = firestore
              .collection(`contracts/${contract.id}/bets`)
              .doc()

            const outcome = y > n ? 'NO' : 'YES' // more in YES pool if prob leans NO

            const bet = getCpmmAnteBet(
              creator,
              contract as FullContract<CPMM, Binary>,
              betDoc.id,
              anteBet,
              outcome
            )

            await betDoc.set(bet)

            const liquidityDoc = firestore
              .collection(`contracts/${contract.id}/liquidity`)
              .doc()

            const lp = getCpmmInitialLiquidity(
              creator,
              contract as FullContract<CPMM, Binary>,
              liquidityDoc.id,
              ante
            )

            await liquidityDoc.set(lp)
          }
        } else if (outcomeType === 'FREE_RESPONSE') {
          const noneAnswerDoc = firestore
            .collection(`contracts/${contract.id}/answers`)
            .doc('0')

          const noneAnswer = getNoneAnswer(contract.id, creator)
          await noneAnswerDoc.set(noneAnswer)

          const anteBetDoc = firestore
            .collection(`contracts/${contract.id}/bets`)
            .doc()

          const anteBet = getFreeAnswerAnte(
            creator,
            contract as FullContract<DPM, FreeResponse>,
            anteBetDoc.id
          )
          await anteBetDoc.set(anteBet)
        }
      }

      return { status: 'success', contract }
    }
  )

const getSlug = async (question: string) => {
  const proposedSlug = slugify(question)

  const preexistingContract = await getContractFromSlug(proposedSlug)

  return preexistingContract
    ? proposedSlug + '-' + randomString()
    : proposedSlug
}

const firestore = admin.firestore()

export async function getContractFromSlug(slug: string) {
  const snap = await firestore
    .collection('contracts')
    .where('slug', '==', slug)
    .get()

  return snap.empty ? undefined : (snap.docs[0].data() as Contract)
}
