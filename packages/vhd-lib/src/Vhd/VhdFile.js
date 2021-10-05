import { BLOCK_UNUSED, FOOTER_SIZE, HEADER_SIZE, PLATFORM_NONE, PLATFORM_W2KU, SECTOR_SIZE } from '../_constants'
import { computeBatSize, sectorsToBytes, buildHeader, buildFooter, BUF_BLOCK_UNUSED } from './_utils'
import { createLogger } from '@xen-orchestra/log'
import { fuFooter, fuHeader, checksumStruct } from '../_structs'
import { set as mapSetBit, test as mapTestBit } from '../_bitmap'
import { VhdAbstract } from './VhdAbstract'
import assert from 'assert'
import getFirstAndLastBlocks from '../_getFirstAndLastBlocks'

const { debug } = createLogger('vhd-lib:VhdFile')

// ===================================================================
//
// Spec:
// https://www.microsoft.com/en-us/download/details.aspx?id=23850
//
// C implementation:
// https://github.com/rubiojr/vhd-util-convert
//
// ===================================================================

// ===================================================================

// Format:
//
// 1. Footer (512)
// 2. Header (1024)
// 3. Unordered entries
//    - BAT (batSize @ header.tableOffset)
//    - Blocks (@ blockOffset(i))
//      - bitmap (blockBitmapSize)
//      - data (header.blockSize)
//    - Parent locators (parentLocatorSize(i) @ parentLocatorOffset(i))
// 4. Footer (512 @ vhdSize - 512)
//
// Variables:
//
// - batSize = min(1, ceil(header.maxTableEntries * 4 / sectorSize)) * sectorSize
// - blockBitmapSize = ceil(header.blockSize / sectorSize / 8 / sectorSize) * sectorSize
// - blockOffset(i) = bat[i] * sectorSize
// - nBlocks = ceil(footer.currentSize / header.blockSize)
// - parentLocatorOffset(i) = header.parentLocatorEntry[i].platformDataOffset
// - parentLocatorSize(i) = header.parentLocatorEntry[i].platformDataSpace * sectorSize
// - sectorSize = 512

export class VhdFile extends VhdAbstract {
  static async open(handler, path) {
    const fd = await handler.openFile(path, 'r+')
    const vhd = new VhdFile(handler, fd)
    // openning a file for reading does not trigger EISDIR as long as we don't really read from it :
    // https://man7.org/linux/man-pages/man2/open.2.html
    // EISDIR pathname refers to a directory and the access requested
    // involved writing (that is, O_WRONLY or O_RDWR is set).
    // reading the header ensure we have a well formed file immediatly
    await vhd.readHeaderAndFooter()
    return {
      dispose: () => handler.closeFile(fd),
      value: vhd,
    }
  }

  static async create(handler, path) {
    const fd = await handler.openFile(path, 'wx')
    const vhd = new VhdFile(handler, fd)
    return {
      dispose: () => handler.closeFile(fd),
      value: vhd,
    }
  }

  get batSize() {
    return computeBatSize(this.header.maxTableEntries)
  }

  constructor(handler, path) {
    super()
    this._handler = handler
    this._path = path
  }

  // =================================================================
  // Read functions.
  // =================================================================

  async _read(start, n) {
    const { bytesRead, buffer } = await this._handler.read(this._path, Buffer.alloc(n), start)
    assert.strictEqual(bytesRead, n)
    return buffer
  }

  containsBlock(id) {
    return this._getBatEntry(id) !== BLOCK_UNUSED
  }

  // TODO:
  // - better human reporting
  // - auto repair if possible
  async readHeaderAndFooter(checkSecondFooter = true) {
    const buf = await this._read(0, FOOTER_SIZE + HEADER_SIZE)
    const bufFooter = buf.slice(0, FOOTER_SIZE)
    const bufHeader = buf.slice(FOOTER_SIZE)

    const footer = buildFooter(bufFooter)
    const header = buildHeader(bufHeader, footer)

    if (checkSecondFooter) {
      const size = await this._handler.getSize(this._path)
      assert(bufFooter.equals(await this._read(size - FOOTER_SIZE, FOOTER_SIZE)), 'footer1 !== footer2')
    }

    this.footer = footer
    this.header = header
  }

  // Returns a buffer that contains the block allocation table of a vhd file.
  async readBlockAllocationTable() {
    const { header } = this
    this.blockTable = await this._read(header.tableOffset, header.maxTableEntries * 4)
  }

  readBlock(blockId, onlyBitmap = false) {
    const blockAddr = this._getBatEntry(blockId)
    if (blockAddr === BLOCK_UNUSED) {
      throw new Error(`no such block ${blockId}`)
    }

    return this._read(sectorsToBytes(blockAddr), onlyBitmap ? this.bitmapSize : this.fullBlockSize).then(buf =>
      onlyBitmap
        ? { id: blockId, bitmap: buf }
        : {
            id: blockId,
            bitmap: buf.slice(0, this.bitmapSize),
            data: buf.slice(this.bitmapSize),
            buffer: buf,
          }
    )
  }

  // =================================================================
  // Write functions.
  // =================================================================

  // Write a buffer at a given position in a vhd file.
  async _write(data, offset) {
    assert(Buffer.isBuffer(data))
    debug(`_write offset=${offset} size=${data.length}`)
    return this._handler.write(this._path, data, offset)
  }

  async _freeFirstBlockSpace(spaceNeededBytes) {
    const firstAndLastBlocks = getFirstAndLastBlocks(this.blockTable)
    if (firstAndLastBlocks === undefined) {
      return
    }

    const { first, firstSector, lastSector } = firstAndLastBlocks
    const tableOffset = this.header.tableOffset
    const { batSize } = this
    const newMinSector = Math.ceil((tableOffset + batSize + spaceNeededBytes) / SECTOR_SIZE)
    if (tableOffset + batSize + spaceNeededBytes >= sectorsToBytes(firstSector)) {
      const { fullBlockSize } = this
      const newFirstSector = Math.max(lastSector + fullBlockSize / SECTOR_SIZE, newMinSector)
      debug(`freeFirstBlockSpace: move first block ${firstSector} -> ${newFirstSector}`)
      // copy the first block at the end
      const block = await this._read(sectorsToBytes(firstSector), fullBlockSize)
      await this._write(block, sectorsToBytes(newFirstSector))
      await this._setBatEntry(first, newFirstSector)
      await this.writeFooter(true)
      spaceNeededBytes -= this.fullBlockSize
      if (spaceNeededBytes > 0) {
        return this._freeFirstBlockSpace(spaceNeededBytes)
      }
    }
  }

  async ensureBatSize(entries) {
    const { header } = this
    const prevMaxTableEntries = header.maxTableEntries
    if (prevMaxTableEntries >= entries) {
      return
    }

    const newBatSize = computeBatSize(entries)
    await this._freeFirstBlockSpace(newBatSize - this.batSize)
    const maxTableEntries = (header.maxTableEntries = entries)
    const prevBat = this.blockTable
    const bat = (this.blockTable = Buffer.allocUnsafe(newBatSize))
    prevBat.copy(bat)
    bat.fill(BUF_BLOCK_UNUSED, prevMaxTableEntries * 4)
    debug(`ensureBatSize: extend BAT ${prevMaxTableEntries} -> ${maxTableEntries}`)
    await this._write(
      Buffer.alloc(maxTableEntries - prevMaxTableEntries, BUF_BLOCK_UNUSED),
      header.tableOffset + prevBat.length
    )
    await this.writeHeader()
  }

  // set the first sector (bitmap) of a block
  _setBatEntry(block, blockSector) {
    const i = block * 4
    const { blockTable } = this

    blockTable.writeUInt32BE(blockSector, i)

    return this._write(blockTable.slice(i, i + 4), this.header.tableOffset + i)
  }

  // Allocate a new uninitialized block in the BAT
  async _createBlock(blockId) {
    assert.strictEqual(this._getBatEntry(blockId), BLOCK_UNUSED)

    const blockAddr = Math.ceil(this._getEndOfData() / SECTOR_SIZE)

    debug(`create block ${blockId} at ${blockAddr}`)

    await this._setBatEntry(blockId, blockAddr)

    return blockAddr
  }

  // Write a bitmap at a block address.
  async _writeBlockBitmap(blockAddr, bitmap) {
    const { bitmapSize } = this

    if (bitmap.length !== bitmapSize) {
      throw new Error(`Bitmap length is not correct ! ${bitmap.length}`)
    }

    const offset = sectorsToBytes(blockAddr)

    debug(`Write bitmap at: ${offset}. (size=${bitmapSize}, data=${bitmap.toString('hex')})`)
    await this._write(bitmap, sectorsToBytes(blockAddr))
  }

  async writeEntireBlock(block) {
    let blockAddr = this._getBatEntry(block.id)

    if (blockAddr === BLOCK_UNUSED) {
      blockAddr = await this._createBlock(block.id)
    }
    await this._write(block.buffer, sectorsToBytes(blockAddr))
  }

  async _writeBlockSectors(block, beginSectorId, endSectorId, parentBitmap) {
    let blockAddr = this._getBatEntry(block.id)

    if (blockAddr === BLOCK_UNUSED) {
      blockAddr = await this._createBlock(block.id)
      parentBitmap = Buffer.alloc(this.bitmapSize, 0)
    } else if (parentBitmap === undefined) {
      parentBitmap = (await this.readBlock(block.id, true)).bitmap
    }

    const offset = blockAddr + this.sectorsOfBitmap + beginSectorId

    debug(`_writeBlockSectors at ${offset} block=${block.id}, sectors=${beginSectorId}...${endSectorId}`)

    for (let i = beginSectorId; i < endSectorId; ++i) {
      mapSetBit(parentBitmap, i)
    }

    await this._writeBlockBitmap(blockAddr, parentBitmap)
    await this._write(
      block.data.slice(sectorsToBytes(beginSectorId), sectorsToBytes(endSectorId)),
      sectorsToBytes(offset)
    )
  }

  async coalesceBlock(child, blockId) {
    const block = await child.readBlock(blockId)
    const { bitmap, data } = block

    debug(`coalesceBlock block=${blockId}`)

    // For each sector of block data...
    const { sectorsPerBlock } = child
    let parentBitmap = null
    for (let i = 0; i < sectorsPerBlock; i++) {
      // If no changes on one sector, skip.
      if (!mapTestBit(bitmap, i)) {
        continue
      }
      let endSector = i + 1

      // Count changed sectors.
      while (endSector < sectorsPerBlock && mapTestBit(bitmap, endSector)) {
        ++endSector
      }

      // Write n sectors into parent.
      debug(`coalesceBlock: write sectors=${i}...${endSector}`)

      const isFullBlock = i === 0 && endSector === sectorsPerBlock
      if (isFullBlock) {
        await this.writeEntireBlock(block)
      } else {
        if (parentBitmap === null) {
          parentBitmap = (await this.readBlock(blockId, true)).bitmap
        }
        await this._writeBlockSectors(block, i, endSector, parentBitmap)
      }

      i = endSector
    }

    // Return the merged data size
    return data.length
  }

  // Write a context footer. (At the end and beginning of a vhd file.)
  async writeFooter(onlyEndFooter = false) {
    const { footer } = this

    const rawFooter = fuFooter.pack(footer)
    const eof = await this._handler.getSize(this._path)
    // sometimes the file is longer than anticipated, we still need to put the footer at the end
    const offset = Math.max(this._getEndOfData(), eof - rawFooter.length)

    footer.checksum = checksumStruct(rawFooter, fuFooter)
    debug(`Write footer at: ${offset} (checksum=${footer.checksum}). (data=${rawFooter.toString('hex')})`)
    if (!onlyEndFooter) {
      await this._write(rawFooter, 0)
    }
    await this._write(rawFooter, offset)
  }

  writeHeader() {
    const { header } = this
    const rawHeader = fuHeader.pack(header)
    header.checksum = checksumStruct(rawHeader, fuHeader)
    const offset = FOOTER_SIZE
    debug(`Write header at: ${offset} (checksum=${header.checksum}). (data=${rawHeader.toString('hex')})`)
    return this._write(rawHeader, offset)
  }

  writeBlockAllocationTable() {
    const { blockTable, header } = this
    debug(`Write BlockAllocationTable at: ${header.tableOffset} ). (data=${blockTable.toString('hex')})`)
    return this._write(blockTable, header.tableOffset)
  }

  async writeData(offsetSectors, buffer) {
    const bufferSizeSectors = Math.ceil(buffer.length / SECTOR_SIZE)
    const startBlock = Math.floor(offsetSectors / this.sectorsPerBlock)
    const endBufferSectors = offsetSectors + bufferSizeSectors
    const lastBlock = Math.ceil(endBufferSectors / this.sectorsPerBlock) - 1
    await this.ensureBatSize(lastBlock)
    const blockSizeBytes = this.sectorsPerBlock * SECTOR_SIZE
    const coversWholeBlock = (offsetInBlockSectors, endInBlockSectors) =>
      offsetInBlockSectors === 0 && endInBlockSectors === this.sectorsPerBlock

    for (let currentBlock = startBlock; currentBlock <= lastBlock; currentBlock++) {
      const offsetInBlockSectors = Math.max(0, offsetSectors - currentBlock * this.sectorsPerBlock)
      const endInBlockSectors = Math.min(endBufferSectors - currentBlock * this.sectorsPerBlock, this.sectorsPerBlock)
      const startInBuffer = Math.max(0, (currentBlock * this.sectorsPerBlock - offsetSectors) * SECTOR_SIZE)
      const endInBuffer = Math.min(
        ((currentBlock + 1) * this.sectorsPerBlock - offsetSectors) * SECTOR_SIZE,
        buffer.length
      )
      let inputBuffer
      if (coversWholeBlock(offsetInBlockSectors, endInBlockSectors)) {
        inputBuffer = buffer.slice(startInBuffer, endInBuffer)
      } else {
        inputBuffer = Buffer.alloc(blockSizeBytes, 0)
        buffer.copy(inputBuffer, offsetInBlockSectors * SECTOR_SIZE, startInBuffer, endInBuffer)
      }
      await this._writeBlockSectors({ id: currentBlock, data: inputBuffer }, offsetInBlockSectors, endInBlockSectors)
    }
    await this.writeFooter()
  }

  async _ensureSpaceForParentLocators(neededSectors) {
    const firstLocatorOffset = FOOTER_SIZE + HEADER_SIZE
    const currentSpace = Math.floor(this.header.tableOffset / SECTOR_SIZE) - firstLocatorOffset / SECTOR_SIZE
    if (currentSpace < neededSectors) {
      const deltaSectors = neededSectors - currentSpace
      await this._freeFirstBlockSpace(sectorsToBytes(deltaSectors))
      this.header.tableOffset += sectorsToBytes(deltaSectors)
      await this._write(this.blockTable, this.header.tableOffset)
    }
    return firstLocatorOffset
  }

  async setUniqueParentLocator(fileNameString) {
    const { header } = this
    header.parentLocatorEntry[0].platformCode = PLATFORM_W2KU
    const encodedFilename = Buffer.from(fileNameString, 'utf16le')
    const dataSpaceSectors = Math.ceil(encodedFilename.length / SECTOR_SIZE)
    const position = await this._ensureSpaceForParentLocators(dataSpaceSectors)
    await this._write(encodedFilename, position)
    header.parentLocatorEntry[0].platformDataSpace = dataSpaceSectors * SECTOR_SIZE
    header.parentLocatorEntry[0].platformDataLength = encodedFilename.length
    header.parentLocatorEntry[0].platformDataOffset = position
    for (let i = 1; i < 8; i++) {
      header.parentLocatorEntry[i].platformCode = PLATFORM_NONE
      header.parentLocatorEntry[i].platformDataSpace = 0
      header.parentLocatorEntry[i].platformDataLength = 0
      header.parentLocatorEntry[i].platformDataOffset = 0
    }
  }

  readParentLocatorData(parentLocatorId) {
    assert(parentLocatorId >= 0, 'parent Locator id must be a positive number')
    assert(parentLocatorId < 8, 'parent Locator id  must be less than 8')
    assert.notStrictEqual(this.header, undefined, `header must be read before it's used`)
    const { platformDataOffset, platformDataSpace } = this.header.parentLocatorEntry[parentLocatorId]
    if (platformDataSpace === 0) {
      return this._read(platformDataOffset, platformDataSpace)
    }
  }

  _writeParentLocator(parentLocatorId, platformDataOffset, data) {
    return this._write(platformDataOffset, data)
  }
}
