export type CellValue = string | number | boolean | null

export interface CellRecord {
  raw: string
  value: CellValue
  error?: string
}

export interface CellCoord {
  row: number
  col: number
}

export interface CellRange {
  start: CellCoord
  end: CellCoord
}

export interface FormulaAst {
  type: 'number' | 'string' | 'boolean' | 'reference' | 'range' | 'binary' | 'unary' | 'function'
  /** 跨表引用时的工作表名称（公式中书写的名字）；未定义表示当前工作表 */
  sheet?: string
  value?: string | number | boolean
  left?: FormulaAst
  right?: FormulaAst
  operator?: string
  name?: string
  args?: FormulaAst[]
}

export type CellMap = Record<string, CellRecord>

/** 工作表：稳定 id + 可变名称 + 独立单元格 */
export interface SheetModel {
  id: string
  name: string
  cells: CellMap
  /** 该工作表上次激活时的活动单元格与选区（切换时还原） */
  active: CellCoord
  selection: CellRange
}

/** 工作簿 */
export interface Workbook {
  sheets: SheetModel[]
  activeSheetId: string
}

/** 历史快照：完整还原工作簿结构、公式与结果 */
export interface HistorySnapshot {
  sheets: SheetModel[]
  activeSheetId: string
  active: CellCoord
  selection: CellRange
}

/** 跨表引用描述符 */
export interface SheetRef {
  /** 工作表名称；undefined 表示当前工作表 */
  sheet?: string
  /** 单元格标识，如 B2 */
  cell: string
}
