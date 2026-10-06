import type { CellMap, SheetState } from '../types/sheet'
import { literalValue } from './cells'

let sheetSeq = 0

export function nextSheetId(): string {
  sheetSeq += 1
  return `sheet_${sheetSeq}_${Math.random().toString(36).slice(2, 8)}`
}

export const SHEET_NAME_MAX = 31

const FORBIDDEN_CHARS = /[!:'"\\/?*[\]]/
const CELL_REF_LIKE = /^\$?[A-Za-z]{1,3}\$?\d+$/

/** 返回 null 表示名称合法，否则返回错误原因 */
export function validateSheetName(name: string, sheets: SheetState[], excludeId?: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return '工作表名称不能为空'
  if (trimmed.length > SHEET_NAME_MAX) return `工作表名称不能超过 ${SHEET_NAME_MAX} 个字符`
  if (FORBIDDEN_CHARS.test(trimmed)) return '名称不能包含 ! : \' " \\ / ? * [ ] 字符'
  if (CELL_REF_LIKE.test(trimmed)) return '名称不能与单元格引用（如 A1）相同'
  if (sheets.some((sheet) => sheet.id !== excludeId && sheet.name.toLowerCase() === trimmed.toLowerCase())) {
    return `已存在名为「${trimmed}」的工作表`
  }
  return null
}

/** 在 base、base (2)、base (3)… 中找到第一个可用的名字 */
export function uniqueSheetName(base: string, sheets: SheetState[]): string {
  const clean = base.trim() || '工作表'
  if (!sheets.some((sheet) => sheet.name.toLowerCase() === clean.toLowerCase())) return clean
  for (let index = 2; ; index += 1) {
    const candidate = `${clean} (${index})`
    if (!sheets.some((sheet) => sheet.name.toLowerCase() === candidate.toLowerCase())) return candidate
  }
}

/** 旧版单表工作簿的持久化形态 */
export interface LegacyWorkbookSnapshot {
  version?: 1
  cells: CellMap
}

export interface WorkbookSnapshot {
  version: 2
  sheets: SheetState[]
  activeSheetId: string
}

/**
 * 把旧版单表数据迁移为多表工作簿：旧数据原样成为首个工作表，
 * 公式文本与计算值逐单元格保留，不做任何改写。
 */
export function migrateLegacyCells(cells: CellMap, sheetName = '季度汇总'): SheetState[] {
  return [{ id: nextSheetId(), name: sheetName, cells: JSON.parse(JSON.stringify(cells)) as CellMap }]
}

function isLegacySnapshot(payload: unknown): payload is LegacyWorkbookSnapshot {
  if (!payload || typeof payload !== 'object' || !('cells' in payload)) return false
  const cells = (payload as LegacyWorkbookSnapshot).cells
  // 旧快照的 cells 是整张 CellMap；若它自身带 raw 字段，说明传入的就是 CellMap
  return !!cells && typeof cells === 'object' && !('raw' in cells)
}

function isWorkbookSnapshot(payload: unknown): payload is WorkbookSnapshot {
  return !!payload && typeof payload === 'object' && Array.isArray((payload as WorkbookSnapshot).sheets)
}

export function migrateWorkbookSnapshot(payload: LegacyWorkbookSnapshot | WorkbookSnapshot | CellMap): WorkbookSnapshot {
  if (isWorkbookSnapshot(payload)) {
    return { version: 2, sheets: payload.sheets, activeSheetId: payload.activeSheetId }
  }
  const cells = isLegacySnapshot(payload) ? payload.cells : (payload as CellMap)
  const sheets = migrateLegacyCells(cells)
  return { version: 2, sheets, activeSheetId: sheets[0].id }
}

function starterCells(): CellMap {
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

/** 初始工作簿：走旧单表快照的迁移路径，首表数据与旧版完全一致 */
export function createStarterWorkbook(): WorkbookSnapshot {
  const legacySnapshot: LegacyWorkbookSnapshot = { version: 1, cells: starterCells() }
  return migrateWorkbookSnapshot(legacySnapshot)
}
