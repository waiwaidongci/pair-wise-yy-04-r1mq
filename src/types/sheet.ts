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
  value?: string | number | boolean
  /** 跨表引用时的工作表名（按公式中书写的原文），同表引用为 undefined */
  sheet?: string
  left?: FormulaAst
  right?: FormulaAst
  operator?: string
  name?: string
  args?: FormulaAst[]
}

export type CellMap = Record<string, CellRecord>

export interface SheetState {
  id: string
  name: string
  cells: CellMap
}

/** 公式依赖的单元格：sheet 为公式中书写的工作表名，省略表示同表 */
export interface FormulaDependency {
  sheet?: string
  id: string
}
