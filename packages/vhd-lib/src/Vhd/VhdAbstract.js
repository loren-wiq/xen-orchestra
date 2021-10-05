import {
  BLOCK_UNUSED,
  FOOTER_SIZE,
  HEADER_SIZE,
  PARENT_LOCATOR_ENTRIES,
  PLATFORM_NONE,
  SECTOR_SIZE,
} from '../_constants'
import { computeBatSize, sectorsRoundUpNoZero, sectorsToBytes } from './_utils'
import { createLogger } from '@xen-orchestra/log'
import assert from 'assert'

const { debug } = createLogger('vhd-lib:VhdAbstract')

export class VhdAbstract {
  #header
  bitmapSize
  blockTable
  footer
  fullBlockSize
  sectorsOfBitmap
  sectorsPerBlock

  get header() {
    assert.notStrictEqual(this.#header, undefined, `header must be read before it's used`)
    return this.#header
  }

  set header(header) {
    this.#header = header
    this.sectorsPerBlock = header.blockSize / SECTOR_SIZE
    this.sectorsOfBitmap = sectorsRoundUpNoZero(this.sectorsPerBlock >> 3)
    this.fullBlockSize = sectorsToBytes(this.sectorsOfBitmap + this.sectorsPerBlock)
    this.bitmapSize = sectorsToBytes(this.sectorsOfBitmap)
  }

  /**
   * instantiate a Vhd
   *
   * @returns {AbstractVhd}
   */
  static async open() {
    throw new Error('open not implemented')
  }

  /**
   * Check if this vhd contains a block with id blockId
   * Must be called after readBlockAllocationTable
   *
   * @param {number} blockId
   * @returns {boolean}
   *
   */
  containsBlock(blockId) {
    throw new Error(`checking if this vhd contains the block ${blockId} is not implemented`)
  }

  /**
   * Read the header and the footer
   * check their integrity
   * if checkSecondFooter also checks that the footer at the end is equal to the one at the beginning
   *
   * @param {boolean} checkSecondFooter
   */
  readHeaderAndFooter(checkSecondFooter = true) {
    throw new Error(
      `reading and checking footer, ${checkSecondFooter ? 'second footer,' : ''} and header is not implemented`
    )
  }

  readBlockAllocationTable() {
    throw new Error(`reading block allocation table is not implemented`)
  }

  /**
   *
   * @param {number} blockId
   * @param {boolean} onlyBitmap
   * @returns {Buffer}
   */
  readBlock(blockId, onlyBitmap = false) {
    throw new Error(`reading  ${onlyBitmap ? 'bitmap of block' : 'block'} ${blockId} is not implemented`)
  }

  /**
   * coalesce the block with id blockId from the child vhd into
   * this vhd
   *
   * @param {AbstractVhd} child
   * @param {number} blockId
   *
   * @returns {number} the merged data size
   */
  coalesceBlock(child, blockId) {
    throw new Error(`coalescing the block ${blockId} from ${child} is not implemented`)
  }

  /**
   * ensure the bat size can store at least entries block
   * move blocks if needed
   * @param {number} entries
   */
  ensureBatSize(entries) {
    throw new Error(`ensuring batSize can store at least  ${entries} is not implemented`)
  }

  // Write a context footer. (At the end and beginning of a vhd file.)
  writeFooter(onlyEndFooter = false) {
    throw new Error(`writing footer   ${onlyEndFooter ? 'only at end' : 'on both side'} is not implemented`)
  }

  writeHeader() {
    throw new Error(`writing header is not implemented`)
  }

  setUniqueParentLocator(fileNameString) {
    throw new Error(`setting unique parent locator from file name ${fileNameString} is not implemented`)
  }

  _writeParentLocator(parentLocatorId, platformDataOffset, data) {
    throw new Error(`write Parent locator ${parentLocatorId} is not implemented`)
  }

  _readParentLocatorData(parentLocatorId, platformDataOffset, platformDataSpace) {
    throw new Error(`read Parent locator ${parentLocatorId} is not implemented`)
  }
  // common
  get batSize() {
    return computeBatSize(this.header.maxTableEntries)
  }

  // return the first sector (bitmap) of a block
  _getBatEntry(blockId) {
    const i = blockId * 4
    const { blockTable } = this
    return i < blockTable.length ? blockTable.readUInt32BE(i) : BLOCK_UNUSED
  }

  // Returns the first address after metadata. (In bytes)
  _getEndOfHeaders() {
    const { header } = this

    let end = FOOTER_SIZE + HEADER_SIZE

    // Max(end, block allocation table end)
    end = Math.max(end, header.tableOffset + this.batSize)

    for (let i = 0; i < PARENT_LOCATOR_ENTRIES; i++) {
      const entry = header.parentLocatorEntry[i]

      if (entry.platformCode !== PLATFORM_NONE) {
        end = Math.max(end, entry.platformDataOffset + sectorsToBytes(entry.platformDataSpace))
      }
    }

    debug(`End of headers: ${end}.`)

    return end
  }

  // Returns the first sector after data.
  _getEndOfData() {
    let end = Math.ceil(this._getEndOfHeaders() / SECTOR_SIZE)

    const sectorsOfFullBlock = this.sectorsOfBitmap + this.sectorsPerBlock
    const { maxTableEntries } = this.header
    for (let i = 0; i < maxTableEntries; i++) {
      const blockAddr = this._getBatEntry(i)

      if (blockAddr !== BLOCK_UNUSED) {
        end = Math.max(end, blockAddr + sectorsOfFullBlock)
      }
    }

    debug(`End of data: ${end}.`)

    return sectorsToBytes(end)
  }

  writeParentLocator(parentLocatorId, data) {
    assert(parentLocatorId >= 0, 'parent Locator id must be a positive number')
    assert(parentLocatorId < 8, 'parent Locator id  must be less than 8')

    let { platformDataOffset, platformDataSpace } = this.header.parentLocatorEntry[parentLocatorId]
    // ensure there is enough place to write it
    if (platformDataSpace > data.length) {
      // growing : put it at the end of the data
      platformDataOffset = this._getEndOfData()
    }
    platformDataSpace = data.length

    // update header data
    this.header.parentLocatorEntry[parentLocatorId].platformDataSpace = platformDataSpace
    this.header.parentLocatorEntry[parentLocatorId].platformDataOffset = platformDataOffset

    if (platformDataSpace !== 0) {
      return this._writeParentLocator(parentLocatorId, platformDataOffset, data)
    }
  }

  readParentLocatorData(parentLocatorId) {
    assert(parentLocatorId >= 0, 'parent Locator id must be a positive number')
    assert(parentLocatorId < 8, 'parent Locator id  must be less than 8')
    const { platformDataOffset, platformDataSpace } = this.header.parentLocatorEntry[parentLocatorId]
    if (platformDataSpace > 0) {
      return this._readParentLocatorData(parentLocatorId, platformDataOffset, platformDataSpace)
    }
  }
}
