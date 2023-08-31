import clsx from 'clsx'
import { Contract } from 'common/contract'
import { useState } from 'react'
import { usePrivateUser } from 'web/hooks/use-user'
import { Button } from './buttons/button'
import { Col } from './layout/col'
import { Modal } from './layout/modal'
import { Row } from './layout/row'
import {
  SupabaseAdditionalFilter,
  SupabaseContractSearch,
} from './contracts-search'
import { LoadingIndicator } from './widgets/loading-indicator'

export function SelectMarketsModal(props: {
  title: string
  description?: React.ReactNode
  open: boolean
  setOpen: (open: boolean) => void
  submitLabel: (length: number) => string
  onSubmit: (contracts: Contract[]) => void | Promise<void>
}) {
  const { title, description, open, setOpen, submitLabel, onSubmit } = props

  return (
    <Modal open={open} setOpen={setOpen} className={'sm:p-0'} size={'lg'}>
      <Col className="bg-canvas-0 text-ink-1000 relative h-[85vh] w-full gap-4 rounded-md p-8">
        <div className={'text-primary-700 pb-0 text-xl'}>{title}</div>
        {description}
        <SelectMarkets
          submitLabel={submitLabel}
          onSubmit={onSubmit}
          setOpen={setOpen}
          className="grow overflow-y-auto"
        />
      </Col>
    </Modal>
  )
}

export function SelectMarkets(props: {
  submitLabel: (length: number) => string
  onSubmit: (contracts: Contract[]) => void | Promise<void>
  setOpen: (open: boolean) => void
  className?: string
  additionalFilter?: SupabaseAdditionalFilter
  headerClassName?: string
}) {
  const {
    submitLabel,
    onSubmit,
    setOpen,
    className,
    additionalFilter,
    headerClassName,
  } = props

  const privateUser = usePrivateUser()
  const [contracts, setContracts] = useState<Contract[]>([])
  const [loading, setLoading] = useState(false)

  async function addContract(contract: Contract) {
    if (contracts.find((c) => c.id === contract.id) !== undefined) {
      setContracts(contracts.filter((c) => c.id !== contract.id))
    } else setContracts([...contracts, contract])
  }

  async function onFinish() {
    setLoading(true)
    await onSubmit(contracts)
    setLoading(false)
    setOpen(false)
    setContracts([])
  }

  return (
    <div className={clsx('px-1', className)}>
      {loading && (
        <div className="w-full justify-center">
          <LoadingIndicator />
        </div>
      )}
      <SupabaseContractSearch
        persistPrefix="contract-select-modal"
        hideOrderSelector
        onContractClick={addContract}
        hideActions
        highlightContractIds={contracts.map((c) => c.id)}
        additionalFilter={{
          excludeContractIds: [
            ...(additionalFilter?.excludeContractIds ?? []),
            ...(privateUser?.blockedContractIds ?? []),
          ],
          excludeGroupSlugs: privateUser?.blockedGroupSlugs,
          excludeUserIds: privateUser?.blockedUserIds,
        }}
        headerClassName={clsx('bg-canvas-0', headerClassName)}
      />
      <Row className="bg-canvas-0 fixed inset-x-0 bottom-0 justify-end px-8 py-2">
        {!loading && (
          <Row className="grow justify-end gap-4">
            <Button
              onClick={() => {
                if (contracts.length > 0) {
                  setContracts([])
                } else {
                  setOpen(false)
                }
              }}
              color="gray"
            >
              {contracts.length > 0 ? 'Reset' : 'Cancel'}
            </Button>
            <Button
              onClick={onFinish}
              color="indigo"
              disabled={contracts.length <= 0}
            >
              {contracts.length > 0
                ? submitLabel(contracts.length)
                : 'Add questions'}
            </Button>
          </Row>
        )}
      </Row>
    </div>
  )
}