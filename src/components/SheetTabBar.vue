<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSheetStore } from '../stores/sheet'

const store = useSheetStore()

const renameDialog = ref(false)
const renameName = ref('')
const renameId = ref('')
const renameError = ref('')
const renameInput = ref<{ focus: () => void; select: () => void } | null>(null)

const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuId = ref('')

const deleteDialog = ref(false)
const deleteName = ref('')

const dragId = ref<string | null>(null)

function addSheet() {
  store.createSheet()
}

function openRename(id: string) {
  const sheet = store.sheets.find((s) => s.id === id)
  if (!sheet) return
  renameId.value = id
  renameName.value = sheet.name
  renameError.value = ''
  renameDialog.value = true
  nextTick(() => {
    renameInput.value?.focus()
    renameInput.value?.select()
  })
}

function submitRename() {
  const error = store.renameSheet(renameId.value, renameName.value)
  if (error) {
    renameError.value = error
    return
  }
  renameDialog.value = false
}

function openContextMenu(event: MouseEvent, id: string) {
  event.preventDefault()
  event.stopPropagation()
  menuId.value = id
  menuX.value = event.clientX
  menuY.value = event.clientY
  menuOpen.value = true
}

function closeContextMenu() {
  menuOpen.value = false
}

function menuRename() {
  closeContextMenu()
  openRename(menuId.value)
}

function menuCopy() {
  store.copySheet(menuId.value)
  closeContextMenu()
}

function askDelete() {
  const sheet = store.sheets.find((s) => s.id === menuId.value)
  deleteName.value = sheet?.name ?? ''
  closeContextMenu()
  deleteDialog.value = true
}

function confirmDelete() {
  store.deleteSheet(menuId.value)
  deleteDialog.value = false
}

function onDragStart(event: DragEvent, id: string) {
  dragId.value = id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }
}

function onDragOver(event: DragEvent, id: string) {
  if (!dragId.value || dragId.value === id) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

function onDrop(event: DragEvent, id: string) {
  event.preventDefault()
  if (dragId.value && dragId.value !== id) store.moveSheet(dragId.value, id)
  dragId.value = null
}

function onDragEnd() {
  dragId.value = null
}

function onWindowClick() {
  closeContextMenu()
}

onMounted(() => window.addEventListener('click', onWindowClick))
onBeforeUnmount(() => window.removeEventListener('click', onWindowClick))
</script>

<template>
  <div class="sheet-tab-bar">
    <button class="add-btn" title="新建工作表" @click.stop="addSheet">
      <v-icon icon="mdi-plus" size="18" />
    </button>
    <div class="tabs">
      <div
        v-for="sheet in store.sheets"
        :key="sheet.id"
        class="tab"
        :class="{ active: sheet.id === store.activeSheetId, dragging: dragId === sheet.id }"
        draggable="true"
        @click="store.activateSheet(sheet.id)"
        @dblclick="openRename(sheet.id)"
        @contextmenu="openContextMenu($event, sheet.id)"
        @dragstart="onDragStart($event, sheet.id)"
        @dragover="onDragOver($event, sheet.id)"
        @drop="onDrop($event, sheet.id)"
        @dragend="onDragEnd"
      >
        <span class="tab-name">{{ sheet.name }}</span>
      </div>
    </div>

    <div
      v-if="menuOpen"
      class="context-menu"
      :style="{ left: `${menuX}px`, top: `${menuY}px` }"
      @click.stop
    >
      <div class="menu-item" @click="menuRename">
        <v-icon icon="mdi-pencil-outline" size="15" />
        <span>重命名</span>
      </div>
      <div class="menu-item" @click="menuCopy">
        <v-icon icon="mdi-content-copy" size="15" />
        <span>复制工作表</span>
      </div>
      <div class="menu-item danger" @click="askDelete">
        <v-icon icon="mdi-delete-outline" size="15" />
        <span>删除工作表</span>
      </div>
    </div>

    <v-dialog v-model="renameDialog" max-width="380" @click.stop>
      <v-card>
        <v-card-title class="dialog-title">重命名工作表</v-card-title>
        <v-card-text>
          <v-text-field
            ref="renameInput"
            v-model="renameName"
            label="工作表名称"
            hide-details="auto"
            @keydown.enter.prevent="submitRename"
          />
          <div v-if="renameError" class="error-text">{{ renameError }}</div>
          <div class="hint">名称不能为空，且不能与已有工作表重名。</div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="renameDialog = false">取消</v-btn>
          <v-btn color="primary" variant="flat" @click="submitRename">确定</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="deleteDialog" max-width="360" @click.stop>
      <v-card>
        <v-card-title class="dialog-title">删除工作表</v-card-title>
        <v-card-text>
          确定删除工作表「<strong>{{ deleteName }}</strong>」吗？引用该表的公式将显示 #REF!。
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="deleteDialog = false">取消</v-btn>
          <v-btn color="error" variant="flat" @click="confirmDelete">删除</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.sheet-tab-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 34px;
  flex: 0 0 34px;
  padding: 0 8px;
  border-top: 1px solid #cfd8e4;
  background: #f2f5f9;
}
.add-btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 1px solid #c8d2df;
  border-radius: 4px;
  color: #2563eb;
  background: #fff;
  cursor: pointer;
}
.add-btn:hover { background: #eaf2ff; }
.tabs { display: flex; align-items: center; gap: 2px; overflow-x: auto; }
.tab {
  display: flex;
  align-items: center;
  height: 26px;
  padding: 0 12px;
  border: 1px solid #c8d2df;
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  color: #475569;
  background: #e8eef7;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition: background .12s;
}
.tab:hover { background: #dde7f3; }
.tab.active {
  color: #1d4ed8;
  background: #fff;
  border-color: #c8d2df;
  font-weight: 700;
}
.tab.dragging { opacity: .4; }
.tab-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
.context-menu {
  position: fixed;
  z-index: 100;
  min-width: 140px;
  padding: 4px;
  border: 1px solid #d8e0ea;
  border-radius: 6px;
  background: #fff;
  box-shadow: 0 6px 20px rgba(15, 30, 55, .18);
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  color: #334155;
  font-size: 12px;
  cursor: pointer;
}
.menu-item:hover { background: #eaf2ff; }
.menu-item.danger { color: #dc2626; }
.menu-item.danger:hover { background: #fef2f2; }
.dialog-title { font-size: 15px; font-weight: 700; }
.error-text { margin-top: 6px; color: #dc2626; font-size: 12px; }
.hint { margin-top: 6px; color: #94a3b8; font-size: 11px; }
</style>
