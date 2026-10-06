import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CellCoord, CellRange, CellRecord, CellValue, SheetState } from '../types/sheet'
import { cellId, displayValue, expandRange, literalValue, normalizeRange, rangeContains } from '../utils/cells'
import { FormulaError, evaluateAst, formulaDependencies, parseFormula, rewriteSheetReferences } from '../utils/formula'
import { createStarterWorkbook, nextSheetId, uniqueSheetName, validateSheetName } from '../utils/workbook'

const ROWS = 1000
const COLS = 26

interface HistorySnapshot {
  sheets: SheetState[]
  activeSheetId: string
  active: CellCoord
  selection: CellRange
}

interface SheetCursor {
  active: CellCoord
  selection: CellRange
}

/** 全局依赖键：`工作表id!单元格id`，工作表 id 由系统生成、改名换序均不变 */
function keyOf(sheetId: string, id: string) {
  return `${sheetId}!${id}`
}

function splitKey(key: string) {
  const sep = key.indexOf('!')
  return { sheetId: key.slice(0, sep), id: key.slice(sep + 1) }
}

export const useSheetStore = defineStore('sheet', () => {
  const rows = ROWS
  const cols = COLS
  const starter = createStarterWorkbook()
  const sheets = ref<SheetState[]>(starter.sheets)
  const activeSheetId = ref(starter.activeSheetId)
  const active = ref<CellCoord>({ row: 1, col: 4 })
  const selection = ref<CellRange>({ start: { row: 1, col: 4 }, end: { row: 1, col: 4 } })
  const cursors = ref<Record<string, SheetCursor>>({})
  const freezeRows = ref(1)
  const freezeCols = ref(1)
  const lastRecalculated = ref<string[]>([])
  const history = ref<HistorySnapshot[]>([])
  const future = ref<HistorySnapshot[]>([])
  const status = ref('工作簿已加载，公式引擎待命')

  const activeSheet = computed(() => sheets.value.find((sheet) => sheet.id === activeSheetId.value) ?? sheets.value[0])
  const activeRaw = computed(() => getRaw(active.value.row, active.value.col))
  const activeValue = computed(() => activeSheet.value.cells[cellId(active.value.row, active.value.col)]?.value ?? null)
  const canUndo = computed(() => history.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)

  function idFor(row: number, col: number) {
    return cellId(row, col)
  }

  function getRaw(row: number, col: number) {
    return activeSheet.value.cells[idFor(row, col)]?.raw ?? ''
  }

  function getRecord(row: number, col: number): CellRecord | undefined {
    return activeSheet.value.cells[idFor(row, col)]
  }

  function sheetIdForName(name: string | undefined, fallback: string): string {
    if (!name) return fallback
    const found = sheets.value.find((sheet) => sheet.name.toLowerCase() === name.toLowerCase())
    if (!found) throw new FormulaError('#REF!')
    return found.id
  }

  /** 全工作簿依赖图：被依赖单元格 -> 依赖它的公式单元格 */
  function dependencyMap() {
    const map = new Map<string, Set<string>>()
    sheets.value.forEach((sheet) => {
      Object.entries(sheet.cells).forEach(([id, cell]) => {
        if (!cell.raw.startsWith('=')) return
        formulaDependencies(cell.raw).forEach((dep) => {
          let targetSheetId: string
          try {
            targetSheetId = sheetIdForName(dep.sheet, sheet.id)
          } catch {
            return
          }
          const depKey = keyOf(targetSheetId, dep.id)
          map.set(depKey, new Set([...(map.get(depKey) ?? []), keyOf(sheet.id, id)]))
        })
      })
    })
    return map
  }

  function affectedCells(startKeys: string[]) {
    const map = dependencyMap()
    const affected = new Set(startKeys)
    const queue = [...startKeys]
    while (queue.length) {
      const key = queue.shift()!
      for (const dependent of map.get(key) ?? []) {
        if (!affected.has(dependent)) {
          affected.add(dependent)
          queue.push(dependent)
        }
      }
    }
    return affected
  }

  function allFormulaKeys() {
    const keys: string[] = []
    sheets.value.forEach((sheet) => {
      Object.entries(sheet.cells).forEach(([id, cell]) => {
        if (cell.raw.startsWith('=')) keys.push(keyOf(sheet.id, id))
      })
    })
    return keys
  }

  function writeResult(key: string, value: CellValue, error?: string) {
    const { sheetId, id } = splitKey(key)
    const sheet = sheets.value.find((item) => item.id === sheetId)
    const record = sheet?.cells[id]
    if (sheet && record) sheet.cells[id] = { ...record, value, error }
  }

  /** 只重算给定的单元格集合；跨表依赖在解析时按表名实时定位，循环引用整链报错并令依赖方失效 */
  function recalculate(keys: Set<string>) {
    const sheetById = new Map(sheets.value.map((sheet) => [sheet.id, sheet]))
    const resolved = new Map<string, CellValue>()
    const failedCycles = new Set<string>()

    const resolve = (key: string, stack: string[]): CellValue => {
      if (resolved.has(key)) return resolved.get(key) ?? null
      if (stack.includes(key)) {
        stack.forEach((item) => failedCycles.add(item))
        throw new FormulaError('#CYCLE!')
      }
      const { sheetId, id } = splitKey(key)
      const record = sheetById.get(sheetId)?.cells[id]
      if (!record) return null
      if (!record.raw.startsWith('=')) {
        const value = literalValue(record.raw)
        resolved.set(key, value)
        return value
      }
      const ast = parseFormula(record.raw)
      const nextStack = [...stack, key]
      const value = evaluateAst(
        ast,
        (sheetName, reference) => resolve(keyOf(sheetIdForName(sheetName, sheetId), reference), nextStack),
        (sheetName, range) => {
          const targetSheetId = sheetIdForName(sheetName, sheetId)
          const [start, end] = range.split(':')
          return expandRange(start, end).map((id) => resolve(keyOf(targetSheetId, id), nextStack))
        },
      ) as CellValue
      resolved.set(key, value)
      return value
    }

    keys.forEach((key) => {
      try {
        writeResult(key, resolve(key, []), undefined)
      } catch (error) {
        const code = error instanceof FormulaError ? error.code : '#ERROR!'
        writeResult(key, null, failedCycles.has(key) ? '#CYCLE!' : code)
      }
    })
    lastRecalculated.value = [...keys]
    status.value = `已重算 ${keys.size} 个受影响单元格`
  }

  function snapshot(): HistorySnapshot {
    return {
      sheets: JSON.parse(JSON.stringify(sheets.value)) as SheetState[],
      activeSheetId: activeSheetId.value,
      active: { ...active.value },
      selection: { start: { ...selection.value.start }, end: { ...selection.value.end } },
    }
  }

  function recordHistory() {
    history.value.push(snapshot())
    if (history.value.length > 80) history.value.shift()
    future.value = []
  }

  function restore(next: HistorySnapshot) {
    sheets.value = next.sheets
    activeSheetId.value = next.activeSheetId
    active.value = next.active
    selection.value = next.selection
    cursors.value = {}
  }

  function setRaw(row: number, col: number, raw: string, record = true) {
    const sheet = activeSheet.value
    const id = idFor(row, col)
    const existing = sheet.cells[id]
    if ((existing?.raw ?? '') === raw) return
    if (record) recordHistory()
    sheet.cells[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) }
    recalculate(affectedCells([keyOf(sheet.id, id)]))
  }

  function setManyRaw(start: CellCoord, matrix: string[][]) {
    recordHistory()
    const sheet = activeSheet.value
    const changed: string[] = []
    matrix.forEach((rowValues, rowOffset) => {
      rowValues.forEach((raw, colOffset) => {
        const row = start.row + rowOffset
        const col = start.col + colOffset
        if (row >= rows || col >= cols) return
        const id = idFor(row, col)
        sheet.cells[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) }
        changed.push(keyOf(sheet.id, id))
      })
    })
    recalculate(affectedCells(changed))
  }

  function setActive(row: number, col: number, extend = false) {
    const next = {
      row: Math.max(0, Math.min(rows - 1, row)),
      col: Math.max(0, Math.min(cols - 1, col)),
    }
    active.value = next
    if (!extend) selection.value = { start: { ...next }, end: { ...next } }
    else selection.value.end = { ...next }
  }

  function setSelectionEnd(row: number, col: number) {
    selection.value.end = {
      row: Math.max(0, Math.min(rows - 1, row)),
      col: Math.max(0, Math.min(cols - 1, col)),
    }
  }

  function selectedMatrix() {
    const range = normalizeRange(selection.value)
    const matrix: string[][] = []
    for (let row = range.start.row; row <= range.end.row; row += 1) {
      const values: string[] = []
      for (let col = range.start.col; col <= range.end.col; col += 1) values.push(getRaw(row, col))
      matrix.push(values)
    }
    return matrix
  }

  function selectedText() {
    return selectedMatrix().map((row) => row.map((cell) => cell.replace(/\t/g, ' ')).join('\t')).join('\n')
  }

  function pasteText(text: string) {
    const matrix = text.replace(/\r/g, '').split('\n').filter((row, index, list) => row.length || index < list.length - 1).map((row) => row.split('\t'))
    if (matrix.length) setManyRaw(active.value, matrix)
  }

  function clearSelection() {
    const range = normalizeRange(selection.value)
    const matrix = Array.from({ length: range.end.row - range.start.row + 1 }, () => Array(range.end.col - range.start.col + 1).fill(''))
    setManyRaw(range.start, matrix)
  }

  function switchSheet(id: string) {
    if (id === activeSheetId.value || !sheets.value.some((sheet) => sheet.id === id)) return
    cursors.value[activeSheetId.value] = {
      active: { ...active.value },
      selection: { start: { ...selection.value.start }, end: { ...selection.value.end } },
    }
    activeSheetId.value = id
    const cursor = cursors.value[id]
    active.value = cursor ? { ...cursor.active } : { row: 0, col: 0 }
    selection.value = cursor
      ? { start: { ...cursor.selection.start }, end: { ...cursor.selection.end } }
      : { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } }
    status.value = `已切换到「${activeSheet.value.name}」，仅读取当前工作表`
  }

  function addSheet(name?: string): boolean {
    // 不传名字时自动生成“工作表N”；显式传入空名/重名/非法名一律拒绝
    const finalName = name === undefined ? uniqueSheetName(`工作表${sheets.value.length + 1}`, sheets.value) : name.trim()
    const error = validateSheetName(finalName, sheets.value)
    if (error) {
      status.value = error
      return false
    }
    recordHistory()
    const sheet: SheetState = { id: nextSheetId(), name: finalName, cells: {} }
    sheets.value.push(sheet)
    activeSheetId.value = sheet.id
    active.value = { row: 0, col: 0 }
    selection.value = { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } }
    status.value = `已新建工作表「${finalName}」`
    return true
  }

  function renameSheet(id: string, name: string): boolean {
    const sheet = sheets.value.find((item) => item.id === id)
    if (!sheet) return false
    const trimmed = name.trim()
    if (trimmed === sheet.name) return true
    const error = validateSheetName(trimmed, sheets.value, id)
    if (error) {
      status.value = error
      return false
    }
    recordHistory()
    const oldName = sheet.name
    const changedKeys: string[] = []
    sheets.value.forEach((item) => {
      Object.entries(item.cells).forEach(([cellIdKey, record]) => {
        if (!record.raw.startsWith('=')) return
        const next = rewriteSheetReferences(record.raw, (refName) =>
          refName.toLowerCase() === oldName.toLowerCase() ? trimmed : null,
        )
        if (next !== record.raw) {
          item.cells[cellIdKey] = { ...record, raw: next }
          changedKeys.push(keyOf(item.id, cellIdKey))
        }
      })
    })
    sheet.name = trimmed
    if (changedKeys.length) recalculate(affectedCells(changedKeys))
    status.value = `「${oldName}」已改名为「${trimmed}」，${changedKeys.length} 条公式已同步、仍指向原表`
    return true
  }

  function copySheet(id: string): boolean {
    const source = sheets.value.find((item) => item.id === id)
    if (!source) return false
    recordHistory()
    const name = uniqueSheetName(`${source.name} 副本`, sheets.value)
    const cells: SheetState['cells'] = {}
    Object.entries(source.cells).forEach(([cellIdKey, record]) => {
      // 仅把指向源表自身的引用改写到副本；指向其他表的跨表引用保持原目标，不串入副本
      const raw = record.raw.startsWith('=')
        ? rewriteSheetReferences(record.raw, (refName) =>
            refName.toLowerCase() === source.name.toLowerCase() ? name : null,
          )
        : record.raw
      cells[cellIdKey] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) }
    })
    const copy: SheetState = { id: nextSheetId(), name, cells }
    sheets.value.splice(sheets.value.indexOf(source) + 1, 0, copy)
    activeSheetId.value = copy.id
    recalculate(new Set(Object.keys(cells).filter((cellIdKey) => cells[cellIdKey].raw.startsWith('=')).map((cellIdKey) => keyOf(copy.id, cellIdKey))))
    status.value = `已复制「${source.name}」为「${name}」，其他表的跨表引用仍指向原表`
    return true
  }

  function moveSheet(id: string, targetIndex: number): boolean {
    const from = sheets.value.findIndex((item) => item.id === id)
    if (from < 0) return false
    const clamped = Math.max(0, Math.min(sheets.value.length - 1, targetIndex))
    const to = from < clamped ? clamped - 1 : clamped
    if (to === from) return false
    recordHistory()
    const [sheet] = sheets.value.splice(from, 1)
    sheets.value.splice(to, 0, sheet)
    status.value = `已调整「${sheet.name}」的位置，公式引用保持不变`
    return true
  }

  function undo() {
    const previous = history.value.pop()
    if (!previous) return
    future.value.push(snapshot())
    restore(previous)
    recalculate(new Set(allFormulaKeys()))
    status.value = '已撤销上一步编辑（含工作表结构与公式）'
  }

  function redo() {
    const next = future.value.pop()
    if (!next) return
    history.value.push(snapshot())
    restore(next)
    recalculate(new Set(allFormulaKeys()))
    status.value = '已恢复编辑（含工作表结构与公式）'
  }

  function isSelected(row: number, col: number) {
    return rangeContains(selection.value, row, col)
  }

  function exportCsv() {
    const sheet = activeSheet.value
    const lines: string[] = []
    for (let row = 0; row < Math.min(rows, 80); row += 1) {
      const values: string[] = []
      let hasData = false
      for (let col = 0; col < cols; col += 1) {
        const record = sheet.cells[idFor(row, col)]
        if (record?.raw) hasData = true
        values.push(`"${displayValue(record?.value ?? '').replace(/"/g, '""')}"`)
      }
      if (hasData || row < 15) lines.push(values.join(','))
    }
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })

    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${sheet.name}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
    status.value = `已导出当前工作表「${sheet.name}」CSV`
  }

  function reset() {
    recordHistory()
    const workbook = createStarterWorkbook()
    sheets.value = workbook.sheets
    activeSheetId.value = workbook.activeSheetId
    cursors.value = {}
    active.value = { row: 1, col: 4 }
    selection.value = { start: { row: 1, col: 4 }, end: { row: 1, col: 4 } }
    recalculate(new Set(allFormulaKeys()))
    status.value = '已恢复示例工作簿'
  }

  recalculate(new Set(allFormulaKeys()))
  status.value = '旧单表工作簿已迁移为首个工作表，公式引擎待命'

  return {
    rows,
    cols,
    sheets,
    activeSheetId,
    activeSheet,
    active,
    selection,
    activeRaw,
    activeValue,
    freezeRows,
    freezeCols,
    lastRecalculated,
    canUndo,
    canRedo,
    status,
    idFor,
    getRaw,
    getRecord,
    setRaw,
    setManyRaw,
    setActive,
    setSelectionEnd,
    selectedMatrix,
    selectedText,
    pasteText,
    clearSelection,
    switchSheet,
    addSheet,
    renameSheet,
    copySheet,
    moveSheet,
    undo,
    redo,
    isSelected,
    exportCsv,
    reset,
  }
})
