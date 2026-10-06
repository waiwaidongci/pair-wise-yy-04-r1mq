import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { CellCoord, CellMap, CellRange, CellRecord, CellValue, FormulaAst, HistorySnapshot, SheetModel } from '../types/sheet'
import { cellId, depKey, displayValue, literalValue, normalizeRange, parseCellId, parseDepKey, rangeContains, validateSheetName } from '../utils/cells'
import { FormulaError, evaluateAst, formulaDependencies, parseFormula, rewriteFormulaSheetReference } from '../utils/formula'

const ROWS = 1000
const COLS = 26
const STORAGE_KEY = 'gridformula-workbook-v1'

function createStarterCells(): CellMap {
  const cells: CellMap = {}
  const put = (id: string, raw: string) => { cells[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) } }
  put('A1', '区域')
  put('B1', '一月')
  put('C1', '二月')
  put('D1', '三月')
  put('E1', '季度合计')
  put('A2', '华北')
  put('B2', '128000')
  put('C2', '143500')
  put('D2', '151200')
  put('A3', '华东')
  put('B3', '186000')
  put('C3', '193400')
  put('D3', '205800')
  put('A4', '华南')
  put('B4', '97000')
  put('C4', '118600')
  put('D4', '126900')
  put('A5', '西南')
  put('B5', '76000')
  put('C5', '83400')
  put('D5', '92100')
  put('E2', '=SUM(B2:D2)')
  put('E3', '=SUM(B3:D3)')
  put('E4', '=SUM(B4:D4)')
  put('E5', '=SUM(B5:D5)')
  put('A6', '合计')
  put('B6', '=SUM(B2:B5)')
  put('C6', '=SUM(C2:C5)')
  put('D6', '=SUM(D2:D5)')
  put('E6', '=SUM(E2:E5)')
  put('A8', '月均销售')
  put('B8', '=ROUND(AVERAGE(B2:B5),0)')
  put('C8', '=ROUND(AVERAGE(C2:C5),0)')
  put('D8', '=ROUND(AVERAGE(D2:D5),0)')
  put('E8', '=ROUND(AVERAGE(E2:E5),0)')
  put('A10', '最高区域')
  put('B10', '=MAX(E2:E5)')
  put('A11', '最低区域')
  put('B11', '=MIN(E2:E5)')
  put('A13', '达标说明')
  put('B13', '=IF(E6>1500000,"达成季度目标","需要关注")')
  return cells
}

function createStarterWorkbook(): SheetModel[] {
  return [{
    id: 'sheet-1',
    name: '季度销售',
    cells: createStarterCells(),
    active: { row: 0, col: 0 },
    selection: { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } },
  }]
}

export const useSheetStore = defineStore('sheet', () => {
  const rows = ROWS
  const cols = COLS
  const sheets = ref<SheetModel[]>([])
  const activeSheetId = ref('')
  /** 当前工作表的单元格（与 sheets 中对应对象保持同步） */
  const cells = ref<CellMap>({})
  const active = ref<CellCoord>({ row: 0, col: 0 })
  const selection = ref<CellRange>({ start: { row: 0, col: 0 }, end: { row: 0, col: 0 } })
  const freezeRows = ref(1)
  const freezeCols = ref(1)
  const lastRecalculated = ref<string[]>([])
  const history = ref<HistorySnapshot[]>([])
  const future = ref<HistorySnapshot[]>([])
  const status = ref('工作簿已加载，公式引擎待命')

  let sheetSeq = 1

  const activeSheet = computed(() => sheets.value.find((s) => s.id === activeSheetId.value))
  const activeRaw = computed(() => cells.value[cellId(active.value.row, active.value.col)]?.raw ?? '')
  const activeValue = computed(() => cells.value[cellId(active.value.row, active.value.col)]?.value ?? null)
  const canUndo = computed(() => history.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)

  function sheetIdByName(name: string): string | undefined {
    const lower = name.toLowerCase()
    return sheets.value.find((s) => s.name.toLowerCase() === lower)?.id
  }

  function sheetNameById(id: string): string {
    return sheets.value.find((s) => s.id === id)?.name ?? ''
  }

  function idFor(row: number, col: number) {
    return cellId(row, col)
  }

  function getRaw(row: number, col: number) {
    return cells.value[idFor(row, col)]?.raw ?? ''
  }

  function getRecord(row: number, col: number): CellRecord | undefined {
    return cells.value[idFor(row, col)]
  }

  /** 构建跨表依赖图：依赖键 -> 依赖方集合 */
  function buildDependencyMap(): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>()
    for (const sheet of sheets.value) {
      for (const [cellIdStr, record] of Object.entries(sheet.cells)) {
        if (!record.raw.startsWith('=')) continue
        const deps = formulaDependencies(record.raw, sheet.id, sheetIdByName)
        const dependentKey = depKey(sheet.id, cellIdStr)
        deps.forEach((dep) => {
          if (!map.has(dep)) map.set(dep, new Set())
          map.get(dep)!.add(dependentKey)
        })
      }
    }
    return map
  }

  /** 从起始单元格出发，找出所有直接与间接受影响的单元格（跨表） */
  function affectedCells(startKeys: string[]): Set<string> {
    const map = buildDependencyMap()
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

  /** 重算指定单元格（跨表增量） */
  function recalculate(keys: Set<string>) {
    const resolved = new Map<string, CellValue>()
    const failedCycles = new Set<string>()

    const resolve = (key: string, stack: string[]): CellValue => {
      if (resolved.has(key)) return resolved.get(key)!
      if (stack.includes(key)) {
        stack.forEach((item) => failedCycles.add(item))
        throw new FormulaError('#CYCLE!')
      }
      const { sheetId, cellId: cellIdStr } = parseDepKey(key)
      const sheet = sheets.value.find((s) => s.id === sheetId)
      const record = sheet?.cells[cellIdStr]
      if (!record) return null
      if (!record.raw.startsWith('=')) {
        const value = literalValue(record.raw)
        resolved.set(key, value)
        return value
      }
      let ast: FormulaAst
      try {
        ast = parseFormula(record.raw)
      } catch {
        throw new FormulaError('#PARSE!')
      }
      const nextStack = [...stack, key]
      const value = evaluateAst(
        ast,
        (ref) => {
          const targetSheetId = ref.sheet ? sheetIdByName(ref.sheet) : sheetId
          if (!targetSheetId) throw new FormulaError('#REF!')
          return resolve(depKey(targetSheetId, ref.cell), nextStack)
        },
        (ref, endCell) => {
          const targetSheetId = ref.sheet ? sheetIdByName(ref.sheet) : sheetId
          if (!targetSheetId) throw new FormulaError('#REF!')
          const ids: string[] = []
          const start = parseCellId(ref.cell)
          const end = parseCellId(endCell)
          if (start && end) {
            for (let row = start.row; row <= end.row; row += 1) {
              for (let col = start.col; col <= end.col; col += 1) ids.push(cellId(row, col))
            }
          }
          return ids.map((id) => resolve(depKey(targetSheetId, id), nextStack))
        },
      ) as CellValue
      resolved.set(key, value)
      return value
    }

    keys.forEach((key) => {
      try {
        const value = resolve(key, [])
        const { sheetId, cellId: cellIdStr } = parseDepKey(key)
        const sheet = sheets.value.find((s) => s.id === sheetId)
        const record = sheet?.cells[cellIdStr]
        if (record) sheet.cells[cellIdStr] = { ...record, value, error: undefined }
      } catch (error) {
        const { sheetId, cellId: cellIdStr } = parseDepKey(key)
        const sheet = sheets.value.find((s) => s.id === sheetId)
        const record = sheet?.cells[cellIdStr]
        if (record) {
          const code = error instanceof FormulaError ? error.code : '#ERROR!'
          sheet.cells[cellIdStr] = { ...record, value: null, error: failedCycles.has(key) ? '#CYCLE!' : code }
        }
      }
    })
    lastRecalculated.value = [...keys]
    status.value = `已重算 ${keys.size} 个受影响单元格`
  }

  function recalculateAll() {
    const keys = new Set<string>()
    for (const sheet of sheets.value) {
      for (const [cellId, record] of Object.entries(sheet.cells)) {
        if (record.raw.startsWith('=')) keys.add(depKey(sheet.id, cellId))
      }
    }
    recalculate(keys)
  }

  function snapshot(): HistorySnapshot {
    return {
      sheets: JSON.parse(JSON.stringify(sheets.value)) as SheetModel[],
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

  function setRaw(row: number, col: number, raw: string, record = true) {
    if (record) recordHistory()
    const id = idFor(row, col)
    const existing = cells.value[id]
    if ((existing?.raw ?? '') === raw) return
    cells.value[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) }
    recalculate(affectedCells([depKey(activeSheetId.value, id)]))
  }

  function setManyRaw(start: CellCoord, matrix: string[][]) {
    recordHistory()
    const changed: string[] = []
    matrix.forEach((rowValues, rowOffset) => {
      rowValues.forEach((raw, colOffset) => {
        const row = start.row + rowOffset
        const col = start.col + colOffset
        if (row >= rows || col >= cols) return
        const id = idFor(row, col)
        cells.value[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) }
        changed.push(depKey(activeSheetId.value, id))
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

  // ---- 工作表操作 ----

  function activateSheet(id: string) {
    if (id === activeSheetId.value) return
    const current = sheets.value.find((s) => s.id === activeSheetId.value)
    if (current) {
      current.active = { ...active.value }
      current.selection = { start: { ...selection.value.start }, end: { ...selection.value.end } }
    }
    activeSheetId.value = id
    const target = sheets.value.find((s) => s.id === id)!
    cells.value = target.cells
    active.value = { ...target.active }
    selection.value = { start: { ...target.selection.start }, end: { ...target.selection.end } }
    status.value = `当前工作表：${target.name}`
  }

  function newSheetName(): string {
    let n = sheets.value.length + 1
    let candidate = `工作表${n}`
    while (sheets.value.some((s) => s.name.toLowerCase() === candidate.toLowerCase())) {
      n += 1
      candidate = `工作表${n}`
    }
    return candidate
  }

  function copySheetName(base: string): string {
    let n = 2
    let candidate = `${base} (2)`
    while (sheets.value.some((s) => s.name.toLowerCase() === candidate.toLowerCase())) {
      n += 1
      candidate = `${base} (${n})`
    }
    return candidate
  }

  function nextSheetId(): string {
    const id = `sheet-${sheetSeq}`
    sheetSeq += 1
    return id
  }

  /** 新建工作表；返回错误信息（null 表示成功） */
  function createSheet(name?: string): string | null {
    const finalName = (name ?? '').trim() || newSheetName()
    const validationError = validateSheetName(finalName)
    if (validationError) return validationError
    if (sheets.value.some((s) => s.name.toLowerCase() === finalName.toLowerCase())) return '已存在同名工作表'
    recordHistory()
    const id = nextSheetId()
    sheets.value.push({
      id,
      name: finalName,
      cells: {},
      active: { row: 0, col: 0 },
      selection: { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } },
    })
    activateSheet(id)
    recalculateAll()
    status.value = `已新建工作表「${finalName}」`
    return null
  }

  /** 重命名工作表；返回错误信息（null 表示成功）。改名后公式仍指向同一张表。 */
  function renameSheet(id: string, newName: string): string | null {
    const sheet = sheets.value.find((s) => s.id === id)
    if (!sheet) return '工作表不存在'
    const name = newName.trim()
    const validationError = validateSheetName(name)
    if (validationError) return validationError
    if (sheets.value.some((s) => s.id !== id && s.name.toLowerCase() === name.toLowerCase())) return '已存在同名工作表'
    if (name === sheet.name) return null
    recordHistory()
    const oldName = sheet.name
    const changedKeys: string[] = []
    for (const s of sheets.value) {
      for (const [cellId, record] of Object.entries(s.cells)) {
        if (!record.raw.startsWith('=')) continue
        const rewritten = rewriteFormulaSheetReference(record.raw, oldName, name)
        if (rewritten !== record.raw) {
          s.cells[cellId] = { ...record, raw: rewritten }
          changedKeys.push(depKey(s.id, cellId))
        }
      }
    }
    sheet.name = name
    recalculate(affectedCells(changedKeys))
    status.value = `已将工作表「${oldName}」改名为「${name}」`
    return null
  }

  /** 复制工作表；副本中指向源表的公式改写为指向副本自身，避免跨表引用串到副本外。 */
  function copySheet(id: string): string | null {
    const source = sheets.value.find((s) => s.id === id)
    if (!source) return '工作表不存在'
    recordHistory()
    const newName = copySheetName(source.name)
    const newId = nextSheetId()
    const copiedCells: CellMap = JSON.parse(JSON.stringify(source.cells))
    for (const [cellId, record] of Object.entries(copiedCells)) {
      if (record.raw.startsWith('=')) {
        copiedCells[cellId] = { ...record, raw: rewriteFormulaSheetReference(record.raw, source.name, newName) }
      }
    }
    const copy: SheetModel = {
      id: newId,
      name: newName,
      cells: copiedCells,
      active: { ...source.active },
      selection: { start: { ...source.selection.start }, end: { ...source.selection.end } },
    }
    const index = sheets.value.findIndex((s) => s.id === id)
    sheets.value.splice(index + 1, 0, copy)
    activateSheet(newId)
    recalculateAll()
    status.value = `已复制工作表「${source.name}」为「${newName}」`
    return null
  }

  /** 删除工作表；返回错误信息（null 表示成功）。被引用的公式将显示 #REF!。 */
  function deleteSheet(id: string): string | null {
    const index = sheets.value.findIndex((s) => s.id === id)
    if (index < 0) return '工作表不存在'
    if (sheets.value.length <= 1) return '工作簿至少保留一个工作表'
    recordHistory()
    const sheet = sheets.value[index]
    const graph = buildDependencyMap()
    const affected = new Set<string>()
    for (const s of sheets.value) {
      if (s.id === id) continue
      for (const [cellId, record] of Object.entries(s.cells)) {
        if (!record.raw.startsWith('=')) continue
        const deps = formulaDependencies(record.raw, s.id, sheetIdByName)
        if ([...deps].some((dep) => parseDepKey(dep).sheetId === id)) {
          affected.add(depKey(s.id, cellId))
        }
      }
    }
    const queue = [...affected]
    while (queue.length) {
      const key = queue.shift()!
      for (const dependent of graph.get(key) ?? []) {
        if (!affected.has(dependent)) {
          affected.add(dependent)
          queue.push(dependent)
        }
      }
    }
    sheets.value.splice(index, 1)
    if (activeSheetId.value === id) {
      const nextIndex = Math.min(index, sheets.value.length - 1)
      activateSheet(sheets.value[nextIndex].id)
    }
    recalculate(affected)
    status.value = `已删除工作表「${sheet.name}」`
    return null
  }

  /** 拖动排序 */
  function moveSheet(fromId: string, toId: string) {
    if (fromId === toId) return
    const from = sheets.value.findIndex((s) => s.id === fromId)
    const to = sheets.value.findIndex((s) => s.id === toId)
    if (from < 0 || to < 0) return
    recordHistory()
    const [moved] = sheets.value.splice(from, 1)
    sheets.value.splice(to, 0, moved)
    status.value = '已调整工作表顺序'
  }

  function undo() {
    const previous = history.value.pop()
    if (!previous) return
    future.value.push(snapshot())
    sheets.value = previous.sheets
    activeSheetId.value = previous.activeSheetId
    const target = sheets.value.find((s) => s.id === activeSheetId.value) ?? sheets.value[0]
    cells.value = target.cells
    active.value = { ...previous.active }
    selection.value = { start: { ...previous.selection.start }, end: { ...previous.selection.end } }
    recalculateAll()
    status.value = '已撤销上一步编辑'
  }

  function redo() {
    const next = future.value.pop()
    if (!next) return
    history.value.push(snapshot())
    sheets.value = next.sheets
    activeSheetId.value = next.activeSheetId
    const target = sheets.value.find((s) => s.id === activeSheetId.value) ?? sheets.value[0]
    cells.value = target.cells
    active.value = { ...next.active }
    selection.value = { start: { ...next.selection.start }, end: { ...next.selection.end } }
    recalculateAll()
    status.value = '已恢复编辑'
  }

  function isSelected(row: number, col: number) {
    return rangeContains(selection.value, row, col)
  }

  function exportCsv() {
    const lines: string[] = []
    for (let row = 0; row < Math.min(rows, 80); row += 1) {
      const values: string[] = []
      let hasData = false
      for (let col = 0; col < cols; col += 1) {
        const record = cells.value[idFor(row, col)]
        if (record?.raw) hasData = true
        values.push(`"${displayValue(record?.value ?? '').replace(/"/g, '""')}"`)
      }
      if (hasData || row < 15) lines.push(values.join(','))
    }
    const sheetName = sheetNameById(activeSheetId.value) || 'sheet'
    const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${sheetName}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
    status.value = `已导出工作表「${sheetName}」`
  }

  function reset() {
    recordHistory()
    sheets.value = createStarterWorkbook()
    activeSheetId.value = sheets.value[0].id
    cells.value = sheets.value[0].cells
    active.value = { row: 0, col: 0 }
    selection.value = { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } }
    sheetSeq = 2
    recalculateAll()
    status.value = '已恢复示例工作簿'
  }

  // ---- 持久化 ----

  function saveWorkbook() {
    try {
      const data = {
        sheets: sheets.value.map((s) => ({ id: s.id, name: s.name, cells: s.cells })),
        activeSheetId: activeSheetId.value,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
      /* 存储不可用时忽略 */
    }
  }

  function loadWorkbook(): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return false
      const data = JSON.parse(raw) as { sheets?: { id: string; name: string; cells: CellMap }[]; activeSheetId?: string }
      if (!Array.isArray(data.sheets) || !data.sheets.length) return false
      sheets.value = data.sheets.map((s) => ({
        id: s.id,
        name: s.name,
        cells: s.cells,
        active: { row: 0, col: 0 },
        selection: { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } },
      }))
      activeSheetId.value = data.activeSheetId && sheets.value.some((s) => s.id === data.activeSheetId)
        ? data.activeSheetId
        : sheets.value[0].id
      cells.value = sheets.value.find((s) => s.id === activeSheetId.value)!.cells
      sheetSeq = Math.max(1, ...sheets.value.map((s) => {
        const match = /^sheet-(\d+)$/.exec(s.id)
        return match ? Number(match[1]) : 0
      })) + 1
      return true
    } catch {
      return false
    }
  }

  function init() {
    if (!loadWorkbook()) {
      sheets.value = createStarterWorkbook()
      activeSheetId.value = sheets.value[0].id
      cells.value = sheets.value[0].cells
      sheetSeq = 2
    }
    active.value = { row: 0, col: 0 }
    selection.value = { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } }
    recalculateAll()
  }

  watch([sheets, activeSheetId], () => saveWorkbook(), { deep: true })

  init()

  return {
    rows,
    cols,
    sheets,
    activeSheetId,
    activeSheet,
    cells,
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
    sheetIdByName,
    sheetNameById,
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
    activateSheet,
    createSheet,
    renameSheet,
    copySheet,
    deleteSheet,
    moveSheet,
    undo,
    redo,
    isSelected,
    exportCsv,
    reset,
  }
})
