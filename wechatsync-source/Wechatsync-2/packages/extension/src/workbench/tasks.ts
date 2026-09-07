/**
 * 模拟草稿任务（阶段1A）：只验证任务状态机与重启恢复，不调用任何真实平台接口。
 *
 * 状态分离（对应审查要求二.7）：
 * - 模拟 draft：未执行 → 校验中 → 上传中 → 保存中 → 模拟完成（未保存草稿）
 * - 公开发布 publish / Excel 登记 register / 文件归档 archive：独立字段，互不联动。
 *   本阶段保存草稿绝不触发登记或归档（后两者恒为「未登记/未归档」，仅展示）。
 *
 * 重启恢复：任务每一步变更都写入 chrome.storage.local；页面重新打开时，
 * 处于中间状态（校验中/上传中/保存中）的任务标记为「结果未知（扩展重启中断）」，
 * 不自动重发——需用户点击「重新模拟」才会创建新任务。
 */

export type DraftStage = '未执行' | '校验中' | '上传中' | '保存中' | '模拟完成（未保存草稿）' | '结果未知（重启中断）' | '失败'
export type SimpleStatus = '未发布' | '人工确认已发布' | '未登记' | '已登记' | '未归档' | '已归档'

export interface SimTask {
  id: string
  packageId: string
  title: string
  root: string
  relativePath: string
  platform: string
  platformName: string
  imageCount: number
  validationIssueCount: number
  simulated: true
  createdAt: number
  updatedAt: number
  draft: { stage: DraftStage; detail: string }
  publish: '未发布' | '人工确认已发布'
  publicUrl?: string
  register: '未登记' | '已登记'
  registerDetail?: string
  archive: '未归档' | '已归档'
  archiveDetail?: string
  /** 服务重启令包 ID 失效后，无法再回读该包 */
  packageIdStale?: boolean
}

const TASKS_KEY = 'yizao_workbench_tasks'
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export async function listTasks(): Promise<SimTask[]> {
  const tasks = (await chrome.storage.local.get(TASKS_KEY))[TASKS_KEY] as SimTask[] | undefined
  return Array.isArray(tasks) ? tasks : []
}

export async function saveTasks(tasks: SimTask[]) {
  await chrome.storage.local.set({ [TASKS_KEY]: tasks })
}

/** 页面加载时恢复：中间状态的任务标记为结果未知，不自动重发。 */
export async function restoreTasks(): Promise<SimTask[]> {
  const tasks = await listTasks()
  let changed = false
  for (const t of tasks) {
    if (['校验中', '上传中', '保存中'].includes(t.draft.stage)) {
      t.draft = { stage: '结果未知（重启中断）', detail: '扩展重启时任务正在执行，结果未确认。不会自动重试；请核对后手动重新模拟。' }
      t.updatedAt = Date.now()
      changed = true
    }
    // 迁移早期原型中容易被误解为真实平台结果的模拟文案。
    if (t.simulated && ['已存草稿', '待人工发布'].includes(t.draft.stage as string)) {
      t.draft = { stage: '模拟完成（未保存草稿）', detail: '模拟流程已完成；没有调用知乎或其他平台，没有生成真实草稿。' }
      t.updatedAt = Date.now()
      changed = true
    }
  }
  if (changed) await saveTasks(tasks)
  return tasks
}

async function updateTask(id: string, mutate: (t: SimTask) => void) {
  const tasks = await listTasks()
  const task = tasks.find((t) => t.id === id)
  if (!task) return
  mutate(task)
  task.updatedAt = Date.now()
  await saveTasks(tasks)
  return task
}

export function cancelSimulation(id: string) {
  const timer = timers.get(id)
  if (timer) { clearTimeout(timer); timers.delete(id) }
}

/** 创建并推进模拟任务；每步持久化，页面关闭即暂停在当前状态。 */
export async function createSimulatedTask(input: Omit<SimTask, 'id' | 'simulated' | 'createdAt' | 'updatedAt' | 'draft' | 'publish' | 'register' | 'archive'>): Promise<SimTask> {
  const task: SimTask = {
    ...input,
    id: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    simulated: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    draft: { stage: '校验中', detail: '模拟：校验发布包完整性' },
    publish: '未发布',
    register: '未登记',
    archive: '未归档',
  }
  await saveTasks([...(await listTasks()), task])

  if (task.validationIssueCount > 0) {
    task.draft = {
      stage: '失败',
      detail: `模拟校验已停止：发布包有 ${task.validationIssueCount} 项问题。未上传、未保存草稿、未登记、未归档。`,
    }
    task.updatedAt = Date.now()
    await updateTask(task.id, (stored) => { stored.draft = task.draft })
    return task
  }

  const step = (delayMs: number, mutate: (t: SimTask) => void) => {
    const timer = setTimeout(async () => {
      timers.delete(task.id)
      await updateTask(task.id, mutate)
    }, delayMs)
    timers.set(task.id, timer)
  }

  step(1200, (t) => { t.draft = { stage: '上传中', detail: `模拟：上传图片 0/${t.imageCount}（不调用平台接口）` } })
  step(2600, (t) => { t.draft = { stage: '上传中', detail: `模拟：上传图片 ${t.imageCount}/${t.imageCount}（不调用平台接口）` } })
  step(3800, (t) => { t.draft = { stage: '保存中', detail: '模拟：提交草稿（不调用平台接口）' } })
  step(5000, (t) => {
    t.draft = { stage: '模拟完成（未保存草稿）', detail: `模拟流程已完成（${new Date().toLocaleString()}）。没有调用平台，没有生成真实草稿，也没有公开发布、登记 Excel 或归档。` }
  })
  return task
}

export async function removeTask(id: string) {
  cancelSimulation(id)
  await saveTasks((await listTasks()).filter((t) => t.id !== id))
}

export async function confirmPublishedSimulated(id: string, publicUrl = '') {
  const task = await updateTask(id, (t) => {
    t.publish = '人工确认已发布'
    t.publicUrl = publicUrl.trim()
    t.updatedAt = Date.now()
    t.draft = {
      ...t.draft,
      detail: `${t.draft.detail}；模拟人工确认发布结果${t.publicUrl ? `（链接：${t.publicUrl}）` : ''}。未写 Excel、未归档。`,
    }
  })
  return task
}

export async function confirmExcelRegisteredSimulated(id: string, detail = '') {
  const task = await updateTask(id, (t) => {
    if (t.publish !== '人工确认已发布') throw new Error('尚未人工确认正式发布，不能登记 Excel')
    t.register = '已登记' as SimTask['register']
    t.registerDetail = detail.trim() || '模拟人工确认 Excel 登记；未写入真实 Excel。'
    t.updatedAt = Date.now()
  })
  return task
}

export async function confirmArchivedSimulated(id: string, detail = '') {
  const task = await updateTask(id, (t) => {
    if (t.publish !== '人工确认已发布') throw new Error('尚未人工确认正式发布，不能归档')
    if (t.register !== '已登记') throw new Error('尚未确认 Excel 已登记，不能归档')
    t.archive = '已归档'
    t.archiveDetail = detail.trim() || '模拟人工确认归档；未移动、未复制、未删除真实文件。'
    t.updatedAt = Date.now()
  })
  return task
}

export async function markPackageIdsStale() {
  const tasks = await listTasks()
  for (const t of tasks) t.packageIdStale = true
  await saveTasks(tasks)
}

/** 刷新任务列表（模拟推进后由界面轮询调用）。 */
export async function refreshTasks(): Promise<SimTask[]> {
  return listTasks()
}
