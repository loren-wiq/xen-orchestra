import AddIcon from '@mui/icons-material/Add'
import React from 'react'
import SettingsBackupRestoreIcon from '@mui/icons-material/SettingsBackupRestore'
import { Map } from 'immutable'
import { SelectChangeEvent } from '@mui/material'
import { withState } from 'reaclette'

import Button from './Button'
import Checkbox from './Checkbox'
import Input from './Input'
import IntlMessage from './IntlMessage'
import Select from './Select'
import { alert } from './Modal'

import XapiConnection, { ObjectsByType, Pif, PifMetrics } from '../libs/xapi'

interface ParentState {
  objectsByType: ObjectsByType
  objectsFetched: boolean
  xapi: XapiConnection
}

interface State {
  isBonded: boolean
  isLoading: boolean
  form: {
    [key: string]: unknown
    bondMode: 'active-backup' | 'balance-slb' | 'lacp' | ''
    description: string
    mtu: string
    nameLabel: string
    pifsId: string | string[]
    vlan: string
  }
}

interface Props {}

interface ParentEffects {}

interface Effects {
  _createNetwork: React.FormEventHandler<HTMLFormElement>
  _handleChange: (e: SelectChangeEvent<unknown> | React.ChangeEvent<{ name: string; value: unknown }>) => void
  _resetForm: () => void
  _toggleBonded: () => void
}

interface Computed {
  collection?: Pif[]
  pifs?: Map<string, Pif>
  pifsMetrics?: Map<string, PifMetrics>
}

const BOND_MODE = ['active-backup', 'balance-slb', 'lacp']

const BUTTON_STYLES = {
  marginRight: 1,
  width: 'fit-content',
}

const OPTION_PIF_RENDERER = (pif: Pif, { pifsMetrics }: { pifsMetrics: Computed['pifsMetrics'] }) =>
  `${pif.device} (${pifsMetrics?.find(metrics => metrics.$ref === pif.metrics)?.device_name ?? 'unknown'})`

const INPUT_STYLES = {
  marginBottom: 2,
}

const AddNetwork = withState<State, Props, Effects, Computed, ParentState, ParentEffects>(
  {
    initialState: () => ({
      isBonded: false,
      isLoading: false,
      form: {
        bondMode: '',
        description: '',
        mtu: '',
        nameLabel: '',
        pifsId: '',
        vlan: '',
      },
    }),
    computed: {
      pifs: state => state.objectsByType.get('PIF'),
      pifsMetrics: state => state.objectsByType.get('PIF_metrics'),
      collection: state =>
        state.pifs
          ?.filter(pif => pif.VLAN === -1 && pif.bond_slave_of === 'OpaqueRef:NULL' && pif.host === pif.$pool.master)
          .sortBy(pif => pif.device)
          .valueSeq()
          .toArray(),
    },
    effects: {
      _createNetwork: async function (e) {
        e.preventDefault()
        if (this.state.isLoading) {
          return
        }
        this.state.isLoading = true
        const { bondMode, description, mtu, nameLabel, pifsId, vlan } = this.state.form

        try {
          await this.state.xapi.createNetwork(
            {
              MTU: +mtu,
              name_description: description,
              name_label: nameLabel,
              VLAN: +vlan,
            },
            { bondMode: bondMode === '' ? undefined : bondMode, pifsId: pifsId === '' ? undefined : pifsId }
          )
          this.effects._resetForm()
        } catch (error) {
          console.error(error)
          if (error instanceof Error) {
            alert({ message: <p>{error.message}</p>, title: <IntlMessage id='networkCreation' /> })
          }
        }
        this.state.isLoading = false
      },
      _handleChange: function (e) {
        // Reason why form values are initialized with empty string and not a undefined value
        // Warning: A component is changing an uncontrolled input to be controlled.
        // This is likely caused by the value changing from undefined to a defined value,
        // which should not happen. Decide between using a controlled or uncontrolled input
        // element for the lifetime of the component.
        // More info: https://reactjs.org/link/controlled-components
        const property = e.target.name
        const { form } = this.state

        if (form[property] !== undefined) {
          this.state.form = {
            ...form,
            [property]: e.target.value,
          }
        }
      },
      _resetForm: function () {
        this.state.isBonded = false
        Object.keys(this.state.form).forEach(property => {
          this.state.form = {
            ...this.state.form,
            [property]: '',
          }
        })
      },
      _toggleBonded: function () {
        if (Array.isArray(this.state.form.pifsId)) {
          this.state.form.pifsId = ''
        } else {
          this.state.form.pifsId = []
        }
        this.state.isBonded = !this.state.isBonded
      },
    },
  },
  ({ effects, state }) => (
    <>
      <form onSubmit={effects._createNetwork}>
        <label>
          <IntlMessage id='bondedNetwork' />
        </label>
        <Checkbox checked={state.isBonded} name='bonded' onChange={effects._toggleBonded} />
        <div>
          <label>
            <IntlMessage id='interface' />
          </label>
          <br />
          <Select
            additionalProps={{ pifsMetrics: state.pifsMetrics }}
            multiple={state.isBonded}
            name='pifsId'
            onChange={effects._handleChange}
            optionRenderer={OPTION_PIF_RENDERER}
            options={state.collection}
            required={state.isBonded}
            sx={INPUT_STYLES}
            value={state.form.pifsId}
          />
        </div>
        <Input
          name='nameLabel'
          onChange={effects._handleChange}
          required
          value={state.form.nameLabel}
          label={<IntlMessage id='name' />}
          sx={INPUT_STYLES}
        />
        <Input
          name='description'
          onChange={effects._handleChange}
          type='text'
          value={state.form.description}
          label={<IntlMessage id='description' />}
          sx={INPUT_STYLES}
        />
        <Input
          name='mtu'
          onChange={effects._handleChange}
          type='number'
          value={state.form.mtu}
          label={<IntlMessage id='mtu' />}
          sx={INPUT_STYLES}
          helperText={<IntlMessage id='defaultValue' values={{ value: 1500 }} />}
        />
        {state.isBonded ? (
          <div>
            <label>
              <IntlMessage id='bondMode' />
            </label>
            <br />
            <Select
              name='bondMode'
              onChange={effects._handleChange}
              options={BOND_MODE}
              required
              sx={INPUT_STYLES}
              value={state.form.bondMode}
            />
          </div>
        ) : (
          <Input
            name='vlan'
            onChange={effects._handleChange}
            type='number'
            value={state.form.vlan}
            label={<IntlMessage id='vlan' />}
            sx={INPUT_STYLES}
            helperText={<IntlMessage id='vlanPlaceholder' />}
          />
        )}
        <Button disabled={state.isLoading} type='submit' color='success' startIcon={<AddIcon />} sx={BUTTON_STYLES}>
          <IntlMessage id='create' />
        </Button>
        <Button
          disabled={state.isLoading}
          onClick={effects._resetForm}
          sx={BUTTON_STYLES}
          startIcon={<SettingsBackupRestoreIcon />}
        >
          <IntlMessage id='reset' />
        </Button>
      </form>
    </>
  )
)

export default AddNetwork
