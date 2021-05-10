import React from 'react'
import { FormattedMessage } from 'react-intl'
import { Map } from 'immutable'
import { withState } from 'reaclette'

import Table, { TableColumn } from '../../components/Table'
import { Network, ObjectsByType, Pif } from '../../libs/xapi'

interface ParentState {
  objectsByType: ObjectsByType
}

interface State {}

interface Props {
  poolId: string
}

interface ParentEffects {}

interface Effects {}

interface Computed {
  managementPIFs?: Map<string, Pif>
  networks?: Map<string, Network>
  objectsFetched: boolean
  PIFs?: Map<string, Pif>
}

const COLUMNS: TableColumn[] = [
  {
    name: <FormattedMessage id='device' />,
    itemRenderer: (pif: Pif) => pif.device,
  },
  {
    name: <FormattedMessage id='DNS' />,
    itemRenderer: (pif: Pif) => pif.DNS,
  },
  {
    name: <FormattedMessage id='gateway' />,
    itemRenderer: (pif: Pif) => pif.gateway,
  },
  {
    name: <FormattedMessage id='IP' />,
    itemRenderer: (pif: Pif) => pif.IP,
  },
]

const PoolNetwork = withState<State, Props, Effects, Computed, ParentState, ParentEffects>(
  {
    computed: {
      managementPIFs: state => state.PIFs?.filter(pif => pif.management),
      networks: (state, props) =>
        state.objectsFetched
          ? state.objectsByType.get('network')?.filter(network => network.$pool.$id === props.poolId)
          : undefined,
      objectsFetched: state => state.objectsByType !== undefined,
      PIFs: state =>
        state.objectsByType.get('PIF')?.filter(pif => state.networks?.find(network => network.$ref === pif.network)),
    },
  },
  ({ state }) => <Table collections={state.managementPIFs} columns={COLUMNS} />
)

export default PoolNetwork
