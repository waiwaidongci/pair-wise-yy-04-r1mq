<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useSheetStore } from '../stores/sheet'
import type { SheetState } from '../types/sheet'

const store = useSheetStore()
const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const dragId = ref<string | null>(null)
const dropTargetId = ref<string | null>(null)

function startRename(sheet: SheetState) {
  renamingId.value = sheet.id
  renameDraft.value = sheet.name
  nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.rename-input')
    input?.focus()
    input?.select()
  })
}

function commitRename(keepOpenOnError: boolean) {
  if (!renamingId.value) return
  const ok = store.renameSheet(renamingId.value, renameDraft.value)
  if (ok || !keepOpenOnError) renamingId.value = null
}

function onDragStart(sheet: SheetState, event: DragEvent) {
  dragId.value = sheet.id
  event.dataTransfer?.setData('text/plain', sheet.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(sheet: SheetState, event: DragEvent) {
  if (!dragId.value || dragId.value === sheet.id) return
  event.preventDefault()
  dropTargetId.value = sheet.id
}

function onDrop(sheet: SheetState, event: DragEvent) {
  event.preventDefault()
  if (dragId.value && dragId.value !== sheet.id) {
    const targetIndex = store.sheets.findIndex((item) => item.id === sheet.id)
    store.moveSheet(dragId.value, targetIndex)
  }
  clearDrag()
}

function clearDrag() {
  dragId.value = null
  dropTargetId.value = null
}
</script>

<template>
  <div class="sheet-tab-bar">
    <div class="sheet-tabs" role="tablist" aria-label="工作表列表">
      <div
        v-for="sheet in store.sheets"
        :key="sheet.id"
        class="sheet-tab"
        :class="{ active: sheet.id === store.activeSheetId, 'drop-target': dropTargetId === sheet.id }"
        role="tab"
        :aria-selected="sheet.id === store.activeSheetId"
        :draggable="renamingId !== sheet.id"
        @click="store.switchSheet(sheet.id)"
        @dblclick="startRename(sheet)"
        @dragstart="onDragStart(sheet, $event)"
        @dragover="onDragOver(sheet, $event)"
        @dragleave="dropTargetId === sheet.id && (dropTargetId = null)"
        @drop="onDrop(sheet, $event)"
        @dragend="clearDrag"
      >
        <input
          v-if="renamingId === sheet.id"
          v-model="renameDraft"
          class="rename-input"
          aria-label="工作表重命名"
          @click.stop
          @keydown.enter.prevent="commitRename(true)"
          @keydown.escape.prevent="renamingId = null"
          @blur="commitRename(false)"
        />
        <template v-else>
          <span class="tab-name">{{ sheet.name }}</span>
          <v-menu location="top" density="compact">
            <template #activator="{ props }">
              <button class="tab-menu-btn" v-bind="props" aria-label="工作表操作" @click.stop @mousedown.stop>▾</button>
            </template>
            <v-list density="compact">
              <v-list-item prepend-icon="mdi-pencil-outline" @click="startRename(sheet)">
                <v-list-item-title>重命名</v-list-item-title>
              </v-list-item>
              <v-list-item prepend-icon="mdi-content-copy" @click="store.copySheet(sheet.id)">
                <v-list-item-title>复制工作表</v-list-item-title>
              </v-list-item>
            </v-list>
          </v-menu>
        </template>
      </div>
      <button class="add-sheet" title="新建工作表" aria-label="新建工作表" @click="store.addSheet()">＋</button>
    </div>
    <span class="sheet-count">{{ store.sheets.length }} 个工作表 · 拖动标签可排序</span>
  </div>
</template>

<style scoped>
.sheet-tab-bar {
  height: 34px;
  flex: 0 0 34px;
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 0 9px;
  border-top: 1px solid #cfd8e4;
  background: #e6ecf4;
}
.sheet-tabs { display: flex; align-items: stretch; gap: 2px; min-width: 0; overflow-x: auto; flex: 1; }
.sheet-tab {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px 0 12px;
  margin-top: 5px;
  border: 1px solid #c4cfdd;
  border-bottom: 0;
  border-radius: 6px 6px 0 0;
  color: #47586e;
  background: #f4f7fb;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
.sheet-tab:hover { background: #fbfdff; }
.sheet-tab.active {
  color: #1d4ed8;
  font-weight: 700;
  background: #fff;
  border-top: 2px solid #2563eb;
  padding-top: 1px;
}
.sheet-tab.drop-target { box-shadow: inset 3px 0 0 #2563eb; }
.tab-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
.tab-menu-btn {
  border: 0;
  padding: 0 3px;
  border-radius: 3px;
  color: #8a97a8;
  background: transparent;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  visibility: hidden;
}
.sheet-tab:hover .tab-menu-btn, .sheet-tab.active .tab-menu-btn { visibility: visible; }
.tab-menu-btn:hover { color: #1d4ed8; background: #e2eaf6; }
.rename-input {
  width: 110px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid #3b82f6;
  border-radius: 3px;
  outline: none;
  color: #172033;
  background: #fff;
  font-size: 12px;
}
.add-sheet {
  align-self: center;
  width: 26px;
  height: 24px;
  flex: 0 0 auto;
  border: 1px dashed #9fb0c6;
  border-radius: 5px;
  color: #2563eb;
  background: #fff;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.add-sheet:hover { border-color: #2563eb; background: #eaf2ff; }
.sheet-count { align-self: center; flex: 0 0 auto; color: #7c8a9e; font-size: 10px; white-space: nowrap; }
</style>
