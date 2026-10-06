import { parseFormula, evaluateAst, formulaDependencies, rewriteFormulaSheetReference, FormulaError } from '../src/utils/formula'
import { depKey, cellId } from '../src/utils/cells'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string) {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    console.error(`FAIL: ${message}`)
  }
}

function assertEq<T>(actual: T, expected: T, message: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed += 1
  } else {
    failed += 1
    console.error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`)
  }
}

// 1. 跨表引用解析
{
  const ast = parseFormula('=华北!B2')
  assertEq(ast.type, 'reference', 'cross-sheet ref type')
  assertEq(ast.sheet, '华北', 'cross-sheet ref sheet')
  assertEq(ast.value, 'B2', 'cross-sheet ref cell')
}

// 2. 跨表区域解析
{
  const ast = parseFormula('=SUM(华北!B2:B5)')
  assertEq(ast.type, 'function', 'cross-sheet range function')
  const range = ast.args![0]
  assertEq(range.type, 'range', 'cross-sheet range type')
  assertEq(range.sheet, '华北', 'cross-sheet range sheet')
  assertEq(range.value, 'B2:B5', 'cross-sheet range value')
}

// 3. 带引号的跨表引用
{
  const ast = parseFormula("='华北 区'!B2")
  assertEq(ast.sheet, '华北 区', 'quoted sheet name with space')
  assertEq(ast.value, 'B2', 'quoted sheet cell')
}

// 4. 依赖收集（带工作表上下文）
{
  const sheetIdByName = (name: string) => (name === '华北' ? 's2' : name === '华东' ? 's3' : undefined)
  const deps = formulaDependencies('=华北!B2+华东!C3', 's1', sheetIdByName)
  assert(deps.has(depKey('s2', 'B2')), 'deps include 华北!B2')
  assert(deps.has(depKey('s3', 'C3')), 'deps include 华东!C3')
  assertEq(deps.size, 2, 'deps size')
}

// 5. 跨表区域依赖展开
{
  const sheetIdByName = (name: string) => (name === '华北' ? 's2' : undefined)
  const deps = formulaDependencies('=SUM(华北!B2:B4)', 's1', sheetIdByName)
  assert(deps.has(depKey('s2', 'B2')), 'range dep B2')
  assert(deps.has(depKey('s2', 'B3')), 'range dep B3')
  assert(deps.has(depKey('s2', 'B4')), 'range dep B4')
  assertEq(deps.size, 3, 'range deps size')
}

// 6. 同表引用不带 sheet
{
  const sheetIdByName = () => undefined
  const deps = formulaDependencies('=B2+C3', 's1', sheetIdByName)
  assert(deps.has(depKey('s1', 'B2')), 'same-sheet dep B2')
  assert(deps.has(depKey('s1', 'C3')), 'same-sheet dep C3')
}

// 7. 公式改写（改名）
{
  const result = rewriteFormulaSheetReference('=华北!B2+SUM(华北!B2:B5)', '华北', '华东')
  assertEq(result, '=华东!B2+SUM(华东!B2:B5)', 'rename rewrite')
}

// 8. 公式改写（带空格的新名称需引号）
{
  const result = rewriteFormulaSheetReference('=华北!B2', '华北', '华北 区')
  assertEq(result, "='华北 区'!B2", 'rename to spaced name quotes')
}

// 9. 公式改写（引号形式）
{
  const result = rewriteFormulaSheetReference("='华北'!B2", '华北', '华东')
  assertEq(result, '=华东!B2', 'quoted old name rewrite')
}

// 10. 求值：跨表引用
{
  const sheetIdByName = (name: string) => (name === '华北' ? 's2' : undefined)
  const cells: Record<string, number> = { [depKey('s2', 'B2')]: 100 }
  const resolveRef = (ref: { sheet?: string; cell: string }) => {
    const sid = ref.sheet ? sheetIdByName(ref.sheet) : 's1'
    return cells[depKey(sid!, ref.cell)] ?? null
  }
  const resolveRange = (start: { sheet?: string; cell: string }, end: string) => {
    const sid = start.sheet ? sheetIdByName(start.sheet) : 's1'
    const [sc, sr] = [start.cell.replace(/\d/g, ''), Number(start.cell.replace(/\D/g, ''))]
    const [ec, er] = [end.replace(/\d/g, ''), Number(end.replace(/\D/g, ''))]
    const vals: number[] = []
    for (let r = sr; r <= er; r++) for (let c = sc.charCodeAt(0); c <= ec.charCodeAt(0); c++) {
      vals.push(cells[depKey(sid!, `${String.fromCharCode(c)}${r}`)] ?? 0)
    }
    return vals
  }
  const ast = parseFormula('=华北!B2*2')
  const value = evaluateAst(ast, resolveRef, resolveRange)
  assertEq(value, 200, 'cross-sheet eval')
}

// 11. 求值：跨表区域求和
{
  const sheetIdByName = (name: string) => (name === '华北' ? 's2' : undefined)
  const cells: Record<string, number> = {
    [depKey('s2', 'B2')]: 10, [depKey('s2', 'B3')]: 20, [depKey('s2', 'B4')]: 30,
  }
  const resolveRef = (ref: { sheet?: string; cell: string }) => {
    const sid = ref.sheet ? sheetIdByName(ref.sheet) : 's1'
    return cells[depKey(sid!, ref.cell)] ?? null
  }
  const resolveRange = (start: { sheet?: string; cell: string }, end: string) => {
    const sid = start.sheet ? sheetIdByName(start.sheet) : 's1'
    const sr = Number(start.cell.replace(/\D/g, ''))
    const er = Number(end.replace(/\D/g, ''))
    const sc = start.cell.replace(/\d/g, '').charCodeAt(0)
    const ec = end.replace(/\d/g, '').charCodeAt(0)
    const vals: number[] = []
    for (let r = sr; r <= er; r++) for (let c = sc; c <= ec; c++) {
      vals.push(cells[depKey(sid!, `${String.fromCharCode(c)}${r}`)] ?? 0)
    }
    return vals
  }
  const ast = parseFormula('=SUM(华北!B2:B4)')
  const value = evaluateAst(ast, resolveRef, resolveRange)
  assertEq(value, 60, 'cross-sheet range SUM')
}

// 12. 跨表循环引用检测
{
  // s1!A1 = 华北!A1 + 1; s2!A1 = 汇总!A1 + 1 => cycle
  const rawFormulas: Record<string, string> = {
    [depKey('s1', 'A1')]: '=华北!A1+1',
    [depKey('s2', 'A1')]: '=汇总!A1+1',
  }
  const nameResolver = (name: string) => {
    if (name === '华北') return 's2'
    if (name === '汇总') return 's1'
    return undefined
  }
  const resolve = (key: string, stack: string[]): unknown => {
    if (stack.includes(key)) throw new FormulaError('#CYCLE!')
    const raw = rawFormulas[key]
    if (!raw) return null
    const ast = parseFormula(raw)
    return evaluateAst(
      ast,
      (ref) => {
        const sid = ref.sheet ? nameResolver(ref.sheet) : key.split('::')[0]
        return resolve(depKey(sid!, ref.cell), [...stack, key])
      },
      () => [],
    )
  }
  let cycle = false
  try {
    resolve(depKey('s1', 'A1'), [])
  } catch (e) {
    cycle = e instanceof FormulaError && e.code === '#CYCLE!'
  }
  assert(cycle, 'cross-sheet circular reference detected')
}

// 13. 复制工作表时，副本内指向源表的公式改写为指向副本
{
  // 源表 "华北" 含公式 =华北!B2（自引用），复制为 "华北 (2)"
  const result = rewriteFormulaSheetReference('=华北!B2', '华北', '华北 (2)')
  assertEq(result, "='华北 (2)'!B2", 'copy sheet self-ref rewrite')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
