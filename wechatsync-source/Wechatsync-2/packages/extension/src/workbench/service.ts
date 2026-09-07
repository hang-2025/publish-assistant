/**
 * 本地只读/模拟原型服务的受限客户端（阶段1A-1C）。
 *
 * - 仅从 workbench 扩展内部页面使用；令牌保存在 chrome.storage.local，
 *   不经过 content script、不暴露给网页（content/api.ts 桥不转发本模块的消息类型）；
 * - 令牌只通过 Authorization 头发送，不进 URL；
 * - 401 时抛出 ServiceAuthError，由界面引导用户重新配对。
 */

const DEFAULT_BASE = 'http://127.0.0.1:8788'
const TOKEN_KEY = 'yizao_service_token'
const BASE_KEY = 'yizao_service_base'

export class ServiceAuthError extends Error {
  constructor() { super('本地服务未配对或令牌无效'); this.name = 'ServiceAuthError' }
}
export class ServiceUnreachableError extends Error {
  constructor() { super('无法连接本地服务（请确认已启动）'); this.name = 'ServiceUnreachableError' }
}

async function storageGet<T>(key: string): Promise<T | undefined> {
  return (await chrome.storage.local.get(key))[key] as T | undefined
}

export async function getServiceBase(): Promise<string> {
  return (await storageGet<string>(BASE_KEY)) || DEFAULT_BASE
}
export async function setServiceBase(base: string) {
  await chrome.storage.local.set({ [BASE_KEY]: base.replace(/\/+$/, '') })
}
export async function getToken(): Promise<string> {
  return (await storageGet<string>(TOKEN_KEY)) || ''
}
export async function setToken(token: string) {
  await chrome.storage.local.set({ [TOKEN_KEY]: token.trim().toLowerCase() })
}

export async function health(): Promise<{ ok: boolean; version: string; protocol: { name: string; version: number } }> {
  try {
    const res = await fetch(`${await getServiceBase()}/api/health`)
    if (!res.ok) throw new Error(`health ${res.status}`)
    return await res.json()
  } catch {
    throw new ServiceUnreachableError()
  }
}

export interface CallOptions { signal?: AbortSignal }

export async function call<T = Record<string, unknown>>(command: string, payload: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
  const token = await getToken()
  let res: Response
  try {
    res = await fetch(`${await getServiceBase()}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ command, payload }),
      signal: options.signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ServiceUnreachableError()
  }
  if (res.status === 401) throw new ServiceAuthError()
  const json = await res.json().catch(() => ({ error: '响应不是有效 JSON' }))
  if (!res.ok || json.ok === false) throw new Error(json.error || `命令失败（${res.status}）`)
  return json as T
}
