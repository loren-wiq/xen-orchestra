const assert = require('assert')
const sum = require('lodash/sum')
const { asyncMap } = require('@xen-orchestra/async-map')
const { Constants, mergeVhd, openVhd, VhdAbstract, VhdFile } = require('vhd-lib')
const { dirname, resolve } = require('path')
const { DISK_TYPES } = Constants
const { isMetadataFile, isVhdFile, isXvaFile, isXvaSumFile } = require('./_backupType.js')
const { limitConcurrency } = require('limit-concurrency-decorator')

const { Task } = require('./Task.js')
const { Disposable } = require('promise-toolbox')

// checking the size of a vhd directory is costly
// 1 Http Query per 1000 blocks
// we only check size of all the vhd are VhdFiles
function shouldComputeVhdsSize(vhds) {
  return vhds.every(vhd => vhd instanceof VhdFile)
}

async function computeVhdsSize(handler, vhdPaths) {
  return await Disposable.use(Disposable.all(vhdPaths.map(vhdPath => openVhd(handler, vhdPath))), async vhds => {
    if (!shouldComputeVhdsSize(vhds)) {
      // don't lose time computing vhd size if some vhds have a non computable size
      return
    }
    const sizes = await asyncMap(vhds, vhd => vhd.getSize())
    return sum(sizes)
  })
}

// chain is an array of VHDs from child to parent
//
// the whole chain will be merged into parent, parent will be renamed to child
// and all the others will deleted
async function mergeVhdChain(chain, { handler, onLog, remove, merge }) {
  assert(chain.length >= 2)

  let child = chain[0]
  const parent = chain[chain.length - 1]
  const children = chain.slice(0, -1).reverse()

  chain
    .slice(1)
    .reverse()
    .forEach(parent => {
      onLog(`the parent ${parent} of the child ${child} is unused`)
    })

  if (merge) {
    // `mergeVhd` does not work with a stream, either
    // - make it accept a stream
    // - or create synthetic VHD which is not a stream
    if (children.length !== 1) {
      // TODO: implement merging multiple children
      children.length = 1
      child = children[0]
    }

    onLog(`merging ${child} into ${parent}`)

    let done, total
    const handle = setInterval(() => {
      if (done !== undefined) {
        onLog(`merging ${child}: ${done}/${total}`)
      }
    }, 10e3)

    const mergedSize = await mergeVhd(
      handler,
      parent,
      handler,
      child,
      // children.length === 1
      //   ? child
      //   : await createSyntheticStream(handler, children),
      {
        onProgress({ done: d, total: t }) {
          done = d
          total = t
        },
      }
    )

    clearInterval(handle)

    await Promise.all([
      VhdAbstract.rename(handler, parent, child),
      asyncMap(children.slice(0, -1), child => {
        onLog(`the VHD ${child} is unused`)
        if (remove) {
          onLog(`deleting unused VHD ${child}`)
          return VhdAbstract.unlink(handler, child)
        }
      }),
    ])

    return mergedSize
  }
}

const noop = Function.prototype

const INTERRUPTED_VHDS_REG = /^(?:(.+)\/)?\.(.+)\.merge.json$/
const listVhds = async (handler, vmDir) => {
  const vhds = []
  const interruptedVhds = new Set()

  await asyncMap(
    await handler.list(`${vmDir}/vdis`, {
      ignoreMissing: true,
      prependDir: true,
    }),
    async jobDir =>
      asyncMap(
        await handler.list(jobDir, {
          prependDir: true,
        }),
        async vdiDir => {
          const list = await handler.list(vdiDir, {
            filter: file => isVhdFile(file) || INTERRUPTED_VHDS_REG.test(file),
            prependDir: true,
          })

          list.forEach(file => {
            const res = INTERRUPTED_VHDS_REG.exec(file)
            if (res === null) {
              vhds.push(file)
            } else {
              const [, dir, file] = res
              interruptedVhds.add(`${dir}/${file}`)
            }
          })
        }
      )
  )

  return { vhds, interruptedVhds }
}

const defaultMergeLimiter = limitConcurrency(1)

exports.cleanVm = async function cleanVm(
  vmDir,
  { fixMetadata, remove, merge, mergeLimiter = defaultMergeLimiter, onLog = noop }
) {
  const limitedMergeVhdChain = mergeLimiter(mergeVhdChain)

  const handler = this._handler

  const vhds = new Set()
  const vhdsToJSons = new Set()
  const vhdParents = { __proto__: null }
  const vhdChildren = { __proto__: null }

  const vhdsList = await listVhds(handler, vmDir)

  // remove broken VHDs
  await asyncMap(vhdsList.vhds, async path => {
    try {
      await Disposable.use(openVhd(handler, path, { checkSecondFooter: !vhdsList.interruptedVhds.has(path) }), vhd => {
        vhds.add(path)
        if (vhd.footer.diskType === DISK_TYPES.DIFFERENCING) {
          const parent = resolve('/', dirname(path), vhd.header.parentUnicodeName)
          vhdParents[path] = parent
          if (parent in vhdChildren) {
            const error = new Error('this script does not support multiple VHD children')
            error.parent = parent
            error.child1 = vhdChildren[parent]
            error.child2 = path
            throw error // should we throw?
          }
          vhdChildren[parent] = path
        }
      })
    } catch (error) {
      onLog(`error while checking the VHD with path ${path}`, { error })
      if (error?.code === 'ERR_ASSERTION' && remove) {
        onLog(`deleting broken ${path}`)
        return VhdAbstract.unlink(handler, path)
      }
    }
  })

  // @todo : add check for data folder of alias not referenced in a valid alias

  // remove VHDs with missing ancestors
  {
    const deletions = []

    // return true if the VHD has been deleted or is missing
    const deleteIfOrphan = vhdPath => {
      const parent = vhdParents[vhdPath]
      if (parent === undefined) {
        return
      }

      // no longer needs to be checked
      delete vhdParents[vhdPath]

      deleteIfOrphan(parent)

      if (!vhds.has(parent)) {
        vhds.delete(vhdPath)

        onLog(`the parent ${parent} of the VHD ${vhdPath} is missing`)
        if (remove) {
          onLog(`deleting orphan VHD ${vhdPath}`)
          deletions.push(VhdAbstract.unlink(handler, vhdPath))
        }
      }
    }

    // > A property that is deleted before it has been visited will not be
    // > visited later.
    // >
    // > -- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for...in#Deleted_added_or_modified_properties
    for (const child in vhdParents) {
      deleteIfOrphan(child)
    }

    await Promise.all(deletions)
  }

  const jsons = []
  const xvas = new Set()
  const xvaSums = []
  const entries = await handler.list(vmDir, {
    prependDir: true,
  })
  entries.forEach(path => {
    if (isMetadataFile(path)) {
      jsons.push(path)
    } else if (isXvaFile(path)) {
      xvas.add(path)
    } else if (isXvaSumFile(path)) {
      xvaSums.push(path)
    }
  })

  await asyncMap(xvas, async path => {
    // check is not good enough to delete the file, the best we can do is report
    // it
    if (!(await this.isValidXva(path))) {
      onLog(`the XVA with path ${path} is potentially broken`)
    }
  })

  const unusedVhds = new Set(vhds)
  const unusedXvas = new Set(xvas)

  // compile the list of unused XVAs and VHDs, and remove backup metadata which
  // reference a missing XVA/VHD
  await asyncMap(jsons, async json => {
    const metadata = JSON.parse(await handler.readFile(json))
    const { mode } = metadata
    let size
    if (mode === 'full') {
      const linkedXva = resolve('/', vmDir, metadata.xva)

      if (xvas.has(linkedXva)) {
        unusedXvas.delete(linkedXva)

        size = await handler.getSize(linkedXva).catch(error => {
          onLog(`failed to get size of ${json}`, { error })
        })
      } else {
        onLog(`the XVA linked to the metadata ${json} is missing`)
        if (remove) {
          onLog(`deleting incomplete backup ${json}`)
          await handler.unlink(json)
        }
      }
    } else if (mode === 'delta') {
      const linkedVhds = (() => {
        const { vhds } = metadata
        return Object.keys(vhds).map(key => resolve('/', vmDir, vhds[key]))
      })()
      // FIXME: find better approach by keeping as much of the backup as
      // possible (existing disks) even if one disk is missing
      if (linkedVhds.every(_ => vhds.has(_))) {
        linkedVhds.forEach(_ => unusedVhds.delete(_))

        linkedVhds.forEach(path => {
          vhdsToJSons[path] = json
        })
        try {
          size = await computeVhdsSize(handler, linkedVhds)
        } catch (error) {
          onLog(`failed to get size of ${json}`, { error })
        }
      } else {
        onLog(`Some VHDs linked to the metadata ${json} are missing`)
        if (remove) {
          onLog(`deleting incomplete backup ${json}`)
          await handler.unlink(json)
        }
      }
    }

    const metadataSize = metadata.size
    if (size !== undefined && metadataSize !== size) {
      onLog(`incorrect size in metadata: ${metadataSize ?? 'none'} instead of ${size}`)

      // don't update if the the stored size is greater than found files,
      // it can indicates a problem
      if (fixMetadata && (metadataSize === undefined || metadataSize < size)) {
        try {
          metadata.size = size
          await handler.writeFile(json, JSON.stringify(metadata), { flags: 'w' })
        } catch (error) {
          onLog(`failed to update size in backup metadata ${json}`, { error })
        }
      }
    }
  })

  // TODO: parallelize by vm/job/vdi
  const unusedVhdsDeletion = []
  const toMerge = []
  {
    // VHD chains (as list from child to ancestor) to merge indexed by last
    // ancestor
    const vhdChainsToMerge = { __proto__: null }

    const toCheck = new Set(unusedVhds)

    const getUsedChildChainOrDelete = vhd => {
      if (vhd in vhdChainsToMerge) {
        const chain = vhdChainsToMerge[vhd]
        delete vhdChainsToMerge[vhd]
        return chain
      }

      if (!unusedVhds.has(vhd)) {
        return [vhd]
      }

      // no longer needs to be checked
      toCheck.delete(vhd)

      const child = vhdChildren[vhd]
      if (child !== undefined) {
        const chain = getUsedChildChainOrDelete(child)
        if (chain !== undefined) {
          chain.push(vhd)
          return chain
        }
      }

      onLog(`the VHD ${vhd} is unused`)
      if (remove) {
        onLog(`deleting unused VHD ${vhd}`)
        unusedVhdsDeletion.push(VhdAbstract.unlink(handler, vhd))
      }
    }

    toCheck.forEach(vhd => {
      vhdChainsToMerge[vhd] = getUsedChildChainOrDelete(vhd)
    })

    // merge interrupted VHDs
    vhdsList.interruptedVhds.forEach(parent => {
      vhdChainsToMerge[parent] = [vhdChildren[parent], parent]
    })

    Object.values(vhdChainsToMerge).forEach(chain => {
      if (chain !== undefined) {
        toMerge.push(chain)
      }
    })
  }

  const doMerge = async () => {
    const metadataToBeUpdated = {}
    await asyncMap(toMerge, async chain => {
      const merged = await limitedMergeVhdChain(chain, { handler, onLog, remove, merge })
      if (merged !== undefined) {
        const metadataPath = vhdsToJSons[chain[0]] // all the chain should have the same metada file
        metadataToBeUpdated[metadataPath] = true
      }
    })

    // update the size in the metadata where there have been some merge
    await asyncMap(Object.keys(metadataToBeUpdated), async metadataPath => {
      const metadata = JSON.parse(await handler.readFile(metadataPath))

      // update size stored in the metadata if possible
      let size
      try {
        size = await computeVhdsSize(handler, metadata.vhds)
        // only update if we are in a normal case of a vhd growing after merge
      } catch (error) {
        onLog(`failed to get size of ${metadataPath} after merge`, { error })
      }
      // write updated metadata file
      // don't reduce the size : a vhd s should not be smaller after merge
      if (metadata.size < size || metadata.size === undefined) {
        metadata.size = size
        try {
          await handler.writeFile(metadataPath, JSON.stringify(metadata), { flags: 'w' })
        } catch (error) {
          onLog(`failed to update size in backup metadata ${metadataPath} after merge`, { error })
        }
      }
    })
  }

  await Promise.all([
    ...unusedVhdsDeletion,
    toMerge.length !== 0 && (merge ? Task.run({ name: 'merge' }, doMerge) : doMerge()),
    asyncMap(unusedXvas, path => {
      onLog(`the XVA ${path} is unused`)
      if (remove) {
        onLog(`deleting unused XVA ${path}`)
        return handler.unlink(path)
      }
    }),
    asyncMap(xvaSums, path => {
      // no need to handle checksums for XVAs deleted by the script, they will be handled by `unlink()`
      if (!xvas.has(path.slice(0, -'.checksum'.length))) {
        onLog(`the XVA checksum ${path} is unused`)
        if (remove) {
          onLog(`deleting unused XVA checksum ${path}`)
          return handler.unlink(path)
        }
      }
    }),
  ])

  return {
    // boolean whether some VHDs were merged (or should be merged)
    merge: toMerge.length !== 0,
  }
}
