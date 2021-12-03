import Cookies from 'js-cookie'
import { EventEmitter } from 'events'
import { Map } from 'immutable'
import { Xapi } from 'xen-api'

export interface XapiObject {
  $pool: Pool
  $ref: string
  $type: keyof types
  $id: string
}

// Dictionary of XAPI types and their corresponding TypeScript types
interface types {
  network: Network
  PIF: Pif
  PIF_metrics: PifMetrics
  pool: Pool
  VM: Vm
  host: Host
}

// XAPI types ---

export interface Network extends XapiObject {
  PIFs: string[]
}

export interface PifMetrics extends XapiObject {
  device_name: string
}

export interface Pif extends XapiObject {
  $network: Network
  bond_slave_of: string
  device: string
  DNS: string
  gateway: string
  host: string
  IP: string
  management: boolean
  metrics: string
  network: string
  VLAN: number
}

export interface Pool extends XapiObject {
  master: string
  name_label: string
}

export interface PoolUpdate {
  changelog: {
    author: string
    date: Date
    description: string
  }
  description: string
  license: string
  name: string
  release: string
  size: number
  url: string
  version: string
}

export interface Vm extends XapiObject {
  $consoles: Array<{ protocol: string; location: string }>
  is_a_snapshot: boolean
  is_a_template: boolean
  is_control_domain: boolean
  name_description: string
  name_label: string
  power_state: string
  resident_on: string
}

export interface Host extends XapiObject {
  name_label: string
  power_state: string
}

// --------

export interface ObjectsByType extends Map<string, Map<string, XapiObject>> {
  get<NSV, T extends keyof types>(key: T, notSetValue: NSV): Map<string, types[T]> | NSV
  get<T extends keyof types>(key: T): Map<string, types[T]> | undefined
}

export default class XapiConnection extends EventEmitter {
  areObjectsFetched: Promise<void>
  connected: boolean
  objectsByType: ObjectsByType
  sessionId?: string

  _resolveObjectsFetched!: () => void

  _xapi?: {
    objects: EventEmitter & {
      all: { [id: string]: XapiObject }
    }
    barrier: (ref: string) => Promise<void>
    connect(): Promise<void>
    disconnect(): Promise<void>
    call: (method: string, ...args: unknown[]) => Promise<unknown>
    _objectsFetched: Promise<void>
  }

  constructor() {
    super()

    this.objectsByType = Map() as ObjectsByType
    this.connected = false
    this.areObjectsFetched = new Promise(resolve => {
      this._resolveObjectsFetched = resolve
    })
  }

  barrier(ref: string): Promise<void> {
    const { _xapi } = this
    if (_xapi === undefined) {
      throw new Error('Not connected to XAPI')
    }
    return _xapi.barrier(ref)
  }

  async reattachSession(url: string): Promise<void> {
    const sessionId = Cookies.get('sessionId')
    if (sessionId === undefined) {
      return
    }

    return this.connect({ url, sessionId })
  }

  async connect({
    url,
    user = 'root',
    password,
    sessionId,
    rememberMe = Cookies.get('rememberMe') === 'true',
  }: {
    url: string
    user?: string
    password?: string
    sessionId?: string
    rememberMe?: boolean
  }): Promise<void> {
    const xapi = (this._xapi = new Xapi({
      auth: { user, password, sessionId },
      url,
      watchEvents: true,
      readonly: false,
    }))

    const updateObjects = (objects: { [id: string]: XapiObject }) => {
      try {
        this.objectsByType = this.objectsByType.withMutations(objectsByType => {
          Object.entries(objects).forEach(([id, object]) => {
            if (object === undefined) {
              // Remove
              objectsByType.forEach((objects, type) => {
                objectsByType.set(type, objects.remove(id))
              })
            } else {
              // Add or update
              const { $type } = object
              objectsByType.set($type, objectsByType.get($type, Map<string, XapiObject>()).set(id, object))
            }
          })
        })

        this.emit('objects', this.objectsByType)
      } catch (err) {
        console.error(err)
      }
    }

    xapi.on('connected', () => {
      this.sessionId = xapi.sessionId
      this.connected = true
      this.emit('connected')
    })

    xapi.on('disconnected', () => {
      Cookies.remove('sessionId')
      this.emit('disconnected')
    })

    xapi.on('sessionId', (sessionId: string) => {
      if (rememberMe) {
        Cookies.set('rememberMe', 'true', { expires: 7 })
      }
      Cookies.set('sessionId', sessionId, rememberMe ? { expires: 7 } : undefined)
    })

    await xapi.connect()
    await xapi._objectsFetched

    updateObjects(xapi.objects.all)
    this._resolveObjectsFetched()

    xapi.objects.on('add', updateObjects)
    xapi.objects.on('update', updateObjects)
    xapi.objects.on('remove', updateObjects)
  }

  disconnect(): Promise<void> | undefined {
    Cookies.remove('rememberMe')
    Cookies.remove('sessionId')
    const { _xapi } = this
    if (_xapi !== undefined) {
      return _xapi.disconnect()
    }
  }

  call(method: string, ...args: unknown[]): Promise<unknown> {
    const { _xapi, connected } = this
    if (!connected || _xapi === undefined) {
      throw new Error('Not connected to XAPI')
    }

    return _xapi.call(method, ...args)
  }

  async createNetworks(
    newNetworks: [
      {
        bondMode?: 'balance-slb' | 'active-backup' | 'lacp'
        MTU: number
        name_description: string
        name_label: string
        pifsId?: string[]
        VLAN: number
      }
    ]
  ): Promise<(string | undefined)[]> {
    const pifs = this.objectsByType.get('PIF')
    return Promise.all(
      newNetworks.map(async ({ bondMode, pifsId, ...newNetwork }) => {
        let networkRef: string | undefined
        try {
          networkRef = (await this.call('network.create', {
            ...newNetwork,
            other_config: { automatic: 'false' },
          })) as string
          await this.barrier(networkRef)
          const networkId = this.objectsByType.get('network')?.find(({ $ref }) => $ref === networkRef)?.$id

          if (pifsId === undefined) {
            return networkId
          }
          if (bondMode !== undefined && pifsId !== undefined) {
            await Promise.all(
              pifsId.map(pifId => this.call('Bond.create', networkRef, pifs?.get(pifId)?.$network.PIFs, '', bondMode))
            )
          } else {
            await this.call('pool.create_VLAN_from_PIF', pifs?.get(pifsId[0])?.$ref, networkRef, newNetwork.VLAN)
          }
          return networkId
        } catch (error) {
          if (networkRef !== undefined) {
            await this.call('network.destroy', networkRef)
          }
          throw error
        }
      })
    )
  }
}
