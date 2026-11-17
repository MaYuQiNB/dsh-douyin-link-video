/**
 * lib/store.mjs —— 状态读写（`$DSH_HOME/qq-douyin-video/state.json`）。
 *
 * 只做「缺字段补默认、越界夹紧、原子写、日志裁剪」；不碰网络。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { stateFile } from './paths.mjs'

export const MAX_LOG = 100
export const MIN_POLL_MS = 8000
export const MAX_POLL_MS = 120_000
/** 记住最近处理过的链接（message_id|url）→ 毫秒时间戳，避免重复发送。 */
export const MAX_RECENT = 300

/** 默认状态。 */
export function defaultState() {
  return {
    version: 1,
    enabled: false,
    /** 绑定的 QQ 会话：private = 好友 QQ 号；group = 群号。 */
    qq: { kind: 'private', id: '', label: '' },
    /** 只处理这个 QQ 号发的链接（群聊必填；私聊留空 = 自动等于对方 QQ 号）。 */
    ownerId: '',
    pollMs: 15_000,
    cursors: { primed: false, lastTime: 0, ids: [] },
    recent: {},
    stats: { sent: 0, errors: 0, lastRunAt: null, lastSentAt: null },
    lastError: '',
    log: [],
    settings: { onebotBaseUrl: '' },
  }
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.round(num)))
}

function textOf(value, fallback = '', max = 200) {
  const text = String(value ?? '').trim()
  if (text === '') return fallback
  return text.slice(0, max)
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeLogRow(row) {
  if (row === null || typeof row !== 'object') return null
  return {
    at: isoOrNull(row.at) || new Date().toISOString(),
    ok: row.ok === true,
    text: textOf(row.text, '', 200),
    note: textOf(row.note, '', 200),
  }
}

/**
 * 把任意输入规整成合法状态。
 * @param {any} raw
 */
export function normalizeState(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const base = defaultState()
  const qq = src.qq !== null && typeof src.qq === 'object' ? src.qq : {}
  base.enabled = src.enabled === true
  base.qq = {
    kind: qq.kind === 'group' ? 'group' : 'private',
    id: textOf(qq.id, '', 30),
    label: textOf(qq.label, '', 80),
  }
  base.ownerId = textOf(src.ownerId, '', 30)
  base.pollMs = clampNumber(src.pollMs, MIN_POLL_MS, MAX_POLL_MS, 15_000)
  const cursors = src.cursors !== null && typeof src.cursors === 'object' ? src.cursors : {}
  base.cursors = {
    primed: cursors.primed === true,
    lastTime: clampNumber(cursors.lastTime, 0, Number.MAX_SAFE_INTEGER, 0),
    ids: Array.isArray(cursors.ids) ? cursors.ids.map(String).filter(Boolean).slice(-200) : [],
  }
  const recentSrc = src.recent !== null && typeof src.recent === 'object' ? src.recent : {}
  const recentEntries = Object.entries(recentSrc)
    .filter(([, at]) => Number.isFinite(Number(at)) && Number(at) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, MAX_RECENT)
  base.recent = Object.fromEntries(recentEntries.map(([key, at]) => [String(key).slice(0, 300), Number(at)]))
  const stats = src.stats !== null && typeof src.stats === 'object' ? src.stats : {}
  base.stats = {
    sent: clampNumber(stats.sent, 0, Number.MAX_SAFE_INTEGER, 0),
    errors: clampNumber(stats.errors, 0, Number.MAX_SAFE_INTEGER, 0),
    lastRunAt: isoOrNull(stats.lastRunAt),
    lastSentAt: isoOrNull(stats.lastSentAt),
  }
  base.lastError = textOf(src.lastError, '', 300)
  base.log = Array.isArray(src.log) ? src.log.map(normalizeLogRow).filter(Boolean).slice(0, MAX_LOG) : []
  const settings = src.settings !== null && typeof src.settings === 'object' ? src.settings : {}
  base.settings = { onebotBaseUrl: textOf(settings.onebotBaseUrl, '', 200) }
  return base
}

/** 读状态：不存在/损坏 → 默认值（损坏文件备份成 `.corrupt-<ts>`）。 */
export function loadState(file = stateFile()) {
  if (!existsSync(file)) return { state: defaultState(), recovered: false, file }
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return { state: normalizeState(JSON.parse(raw)), recovered: false, file }
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* 备份失败就算了 */
    }
    return { state: defaultState(), recovered: true, file }
  }
}

/** 原子写状态。 */
export function saveState(state, file = stateFile()) {
  const normalized = normalizeState(state)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return normalized
}

/** 推一条日志（就地改 state）。 */
export function pushLog(state, row) {
  const normalized = normalizeLogRow(row)
  if (normalized === null) return
  state.log = [normalized, ...(Array.isArray(state.log) ? state.log : [])].slice(0, MAX_LOG)
}

/**
 * 对外展示用的状态（不含 access token；带配置是否已就绪）。
 * @param {ReturnType<typeof defaultState>} state
 * @param {{ configured?: boolean, tools?: any, onebot?: any }} extra
 */
export function publicState(state, extra = {}) {
  return {
    version: 1,
    enabled: state.enabled === true,
    configured: extra.configured === true,
    qq: { kind: state.qq.kind, id: state.qq.id, label: state.qq.label },
    ownerId: state.ownerId,
    pollMs: state.pollMs,
    stats: { ...state.stats },
    lastError: state.lastError,
    cursors: { primed: state.cursors.primed, lastTime: state.cursors.lastTime },
    discover: extra.tools || null,
    onebot: extra.onebot || null,
    log: (Array.isArray(state.log) ? state.log : []).slice(0, 10),
  }
}
