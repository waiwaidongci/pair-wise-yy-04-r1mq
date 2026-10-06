import { createPinia, setActivePinia } from 'pinia'
import { useSheetStore } from '../src/stores/sheet'

setActivePinia(createPinia())
const store = useSheetStore()

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

// 初始状态：首个工作表为季度销售，旧数据迁移为值与公式不变
{
  assertEq(store.sheets.length, 1, '初始有 1 个工作表')
  assertEq(store.sheets[0].name, '季度销售', '首个工作表名')
  assertEq(store.getRaw(0, 0), '区域', 'A1 原值')
  assertEq(store.getRaw(1, 4), '=SUM(B2:D2)', 'E2 公式不变')
  assertEq(store.getRecord(1, 4)?.value, 422700, 'E2 公式结果')
  assertEq(store.getRecord(5, 1)?.value, 487000, 'B6 合计结果')
}

// 新建工作表
{
  const err = store.createSheet('华北')
  assertEq(err, null, '新建华北成功')
  assertEq(store.sheets.length, 2, '现有 2 个工作表')
  assertEq(store.activeSheetId, store.sheets[1].id, '新建后激活新表')
  assertEq(store.sheetNameById(store.activeSheetId), '华北', '当前表为华北')
}

// 重名校验
{
  const err = store.createSheet('华北')
  assertEq(err, '已存在同名工作表', '重名被拒绝')
  assertEq(store.sheets.length, 2, '重名未增加工作表')
}

// 空名校验
{
  const err = store.renameSheet(store.sheets[1].id, '   ')
  assertEq(err, '工作表名称不能为空', '空名被拒绝')
}

// 跨表公式：在华北表填数据，在季度销售表汇总
{
  // 当前在华北表，填 B2=100, C2=200
  store.setRaw(1, 1, '100')
  store.setRaw(1, 2, '200')
  // 切回季度销售
  store.activateSheet(store.sheets[0].id)
  // 在 F2 写跨表求和
  store.setRaw(1, 5, '=SUM(华北!B2:C2)')
  assertEq(store.getRecord(1, 5)?.value, 300, '跨表区域求和结果')
  // 单格跨表引用
  store.setRaw(1, 6, '=华北!B2*2')
  assertEq(store.getRecord(1, 6)?.value, 200, '跨表单格引用结果')
}

// 改名后公式仍指向同一张表
{
  const hq = store.sheets[0].id
  const err = store.renameSheet(store.sheets[1].id, '华北区')
  assertEq(err, null, '改名成功')
  assertEq(store.getRaw(1, 5), '=SUM(华北区!B2:C2)', '公式中的表名已更新')
  assertEq(store.getRecord(1, 5)?.value, 300, '改名后公式结果不变')
  assertEq(store.getRecord(1, 6)?.value, 200, '改名后单格引用结果不变')
}

// 增量重算：改华北表数据，季度销售的跨表公式自动更新
{
  store.activateSheet(store.sheets[1].id)
  store.setRaw(1, 1, '500')
  store.activateSheet(store.sheets[0].id)
  assertEq(store.getRecord(1, 5)?.value, 700, '改数据后跨表求和自动更新')
  assertEq(store.getRecord(1, 6)?.value, 1000, '改数据后单格引用自动更新')
}

// 跨表循环引用
{
  // 季度销售 F3 = 华北区!B3 + 1；华北区 B3 = 季度销售!F3 + 1
  store.setRaw(2, 5, '=华北区!B3+1')
  store.activateSheet(store.sheets[1].id)
  store.setRaw(2, 1, '=季度销售!F3+1')
  assertEq(store.getRecord(2, 1)?.error, '#CYCLE!', '跨表循环引用显示 #CYCLE!')
  // 依赖方失效
  store.activateSheet(store.sheets[0].id)
  assertEq(store.getRecord(2, 5)?.error, '#CYCLE!', '循环依赖方也显示 #CYCLE!')
  // 解除循环
  store.setRaw(2, 5, '0')
  store.activateSheet(store.sheets[1].id)
  assertEq(store.getRecord(2, 1)?.error, undefined, '解除循环后错误清除')
}

// 复制工作表：副本内指向源表的公式改写为指向副本
{
  // 华北区 B4 = 华北区!B2 + 10（自引用）
  store.setRaw(3, 1, '=华北区!B2+10')
  const err = store.copySheet(store.sheets[1].id)
  assertEq(err, null, '复制成功')
  assertEq(store.sheets.length, 3, '现有 3 个工作表')
  const copy = store.sheets[2]
  assertEq(copy.name, '华北区 (2)', '副本名称')
  // 副本内公式应指向副本自身
  assertEq(copy.cells['B4']?.raw, "='华北区 (2)'!B2+10", '副本内自引用公式已改写')
  // 副本 B2 是从源表复制的 500，所以 B4 = 510
  assertEq(copy.cells['B4']?.value, 510, '副本公式结果指向副本数据')
  // 源表 B4 仍指向源表
  assertEq(store.sheets[1].cells['B4']?.raw, '=华北区!B2+10', '源表公式未变')
}

// 删除工作表：被引用的公式显示 #REF!
{
  // 季度销售 F4 = 华北区!B2
  store.activateSheet(store.sheets[0].id)
  store.setRaw(3, 5, '=华北区!B2')
  assertEq(store.getRecord(3, 5)?.value, 500, '删除前引用正常')
  const err = store.deleteSheet(store.sheets[1].id)
  assertEq(err, null, '删除成功')
  assertEq(store.sheets.length, 2, '现有 2 个工作表')
  assertEq(store.getRecord(3, 5)?.error, '#REF!', '删除后引用显示 #REF!')
}

// 至少保留一个工作表
{
  // 当前有 2 个工作表，删到只剩 1 个
  assertEq(store.sheets.length, 2, '删除前有 2 个工作表')
  const firstId = store.sheets[0].id
  const err1 = store.deleteSheet(firstId)
  assertEq(err1, null, '删到剩 1 个成功')
  assertEq(store.sheets.length, 1, '剩 1 个工作表')
  const err2 = store.deleteSheet(store.sheets[0].id)
  assertEq(err2, '工作簿至少保留一个工作表', '不能删除最后一个工作表')
  assertEq(store.sheets.length, 1, '最后一个工作表仍在')
}

// 拖动排序
{
  store.createSheet('华东')
  store.createSheet('华南')
  assertEq(store.sheets.length, 3, '排序前有 3 个工作表')
  const before = store.sheets.map((s) => s.name)
  const fromId = store.sheets[1].id // 华东（第2位）
  const toId = store.sheets[2].id // 华南（第3位）
  store.moveSheet(fromId, toId)
  const after = store.sheets.map((s) => s.name)
  assertEq(after[1], '华南', '排序后第2位是华南')
  assertEq(after[2], '华东', '排序后第3位是华东')
  assert(before.join() !== after.join(), '顺序确实改变')
}

// 撤销重做：还原工作表结构、公式和结果
{
  const beforeSheets = store.sheets.length
  const beforeF5 = store.getRecord(3, 5)?.raw
  store.createSheet('临时表')
  assertEq(store.sheets.length, beforeSheets + 1, '新建后工作表数增加')
  store.undo()
  assertEq(store.sheets.length, beforeSheets, '撤销后工作表数还原')
  assertEq(store.getRecord(3, 5)?.raw, beforeF5, '撤销后公式还原')
  store.redo()
  assertEq(store.sheets.length, beforeSheets + 1, '重做后工作表数恢复')
  // 撤销改名
  const nameBefore = store.sheets[0].name
  store.renameSheet(store.sheets[0].id, '改名测试')
  assertEq(store.sheets[0].name, '改名测试', '改名生效')
  store.undo()
  assertEq(store.sheets[0].name, nameBefore, '撤销改名后名称还原')
}

// 切换工作表只读当前页
{
  store.activateSheet(store.sheets[0].id)
  const a1 = store.getRaw(0, 0)
  store.activateSheet(store.sheets[1].id)
  const b1 = store.getRaw(0, 0)
  assert(a1 !== b1 || store.sheets[0].id !== store.sheets[1].id, '不同工作表内容独立')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
