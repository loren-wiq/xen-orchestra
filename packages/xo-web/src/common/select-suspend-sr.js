import _ from 'intl'
import React from 'react'
import defined, { get } from '@xen-orchestra/defined'
import { injectState, provideState } from 'reaclette'

import decorate from './apply-decorators'
import Icon from './icon'
import renderXoItem from './render-xo-item'
import { connectStore } from './utils'
import { createGetObject } from './selectors'
import { editVm, editPool } from './xo'
import { XoSelect } from './editable'

export const SuspendSrSelect = decorate([
  connectStore({
    suspendSr: createGetObject((_, props) => (props.vm || props.pool).suspendSr),
  }),
  provideState({
    effects: {
      onChange(_, value) {
        const method = this.props.vm !== undefined ? editVm : editPool
        method(this.props.vm || this.props.pool, {
          suspendSr: defined(
            get(() => value.id),
            null
          ),
        })
      },
    },
  }),
  injectState,
  ({ effects: { onChange }, suspendSr }) => (
    <span>
      <XoSelect onChange={onChange} value={suspendSr} xoType='SR'>
        {suspendSr ? renderXoItem(suspendSr) : _('noValue')}
      </XoSelect>{' '}
      {suspendSr && (
        <a role='button' onClick={onChange}>
          <Icon icon='remove' />
        </a>
      )}
    </span>
  ),
])
