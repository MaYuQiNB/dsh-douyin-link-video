/**
 * dsh-douyin-link-video —— 宿主半端
 * ============================================================================
 * 一句话：**抖音链接 → 视频**。在 QQ 聊天里发一条抖音视频链接，插件自动把这条视频（MP4）
 * 下载下来并发回同一个 QQ 会话 —— 只存视频，不抽帧、不转写。
 *
 * 工作方式（完全本地，不借助云端）：
 *   1. 轮询绑定的 QQ 会话（SnowLuma OneBot v11 HTTP，端口/令牌从 `$DSH_HOME/qq-bridge/config.json` 发现）；
 *   2. 扫到对方发来的抖音链接（`https://www.douyin.com/video/<id>` 或 `v.douyin.com` 短链）；
 *   3. 复用本机「刷抖音」插件（dsh-douyin-scroll）已登录的签名接口取 `play_addr`，下载 MP4；
 *   4. 通过 OneBot 以**视频消息**发回原会话，然后删掉临时文件。
 *
 * 边界：只下载 MP4，不抽帧、不转写、不点赞、不评论、不发私信给其他人。
 * 状态/日志在 `$DSH_HOME/douyin-link-video/state.json`，不写进插件包目录。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createOneBot } from './lib/onebot.mjs'
import { extractTargets, resolveAwemeTarget } from './lib/links.mjs'
import { discoverDouyinTools, downloadVideo, fetchVideoDetail, readOneBotConfig } from './lib/douyin.mjs'
import {
  MAX_POLL_MS,
  MIN_POLL_MS,
  loadState,
  normalizeState,
  publicState,
  pushLog,
  saveState,
} from './lib/store.mjs'
import { stateFile, tmpDir } from './lib/paths.mjs'

export const inject = ['tools']

const VERSION = '0.1.0'
/** 每轮最多处理几条带链接的消息（防止刷屏/长时间占用）。 */
const MAX_PER_TICK = 3

/**
 * @param {import('@deepseek-ai/dsh-tools').Context} ctx
 */
export function apply(ctx) {
  let state = loadState().state
  /** @type {NodeJS.Timeout | null} */
  let timer = null
  let ticking = false

  /** 提交状态（规整 + 原子写）。 */
  function commit(mutator) {
    if (typeof mutator === 'function') mutator(state)
    state = normalizeState(state)
    saveState(state)
  }

  function recordError(message) {
    const note = String(message || '').slice(0, 280)
    state.lastError = note
    state.stats.errors += 1
    pushLog(state, { at: new Date().toISOString(), ok: false, text: '本轮失败', note })
    saveState(state)
  }

  /** OneBot 客户端 + 配置来源。 */
  function clients() {
    const cfg = readOneBotConfig()
    const baseUrl = String(state.settings.onebotBaseUrl || cfg.baseUrl || '').trim()
    return {
      onebot: createOneBot({ baseUrl, token: cfg.accessToken }),
      baseUrl,
      tokenFound: cfg.accessToken !== '',
    }
  }

  /** 把 QQ 消息的文本内容拼出来（去掉 CQ 码，保留链接）。 */
  function messageText(raw) {
    const segments = Array.isArray(raw && raw.message) ? raw.message : null
    if (segments !== null) {
      const parts = []
      for (const segment of segments) {
        if (segment === null || typeof segment !== 'object') continue
        const type = String(segment.type || '')
        const data = segment.data !== null && typeof segment.data === 'object' ? segment.data : {}
        if (type === 'text') parts.push(String(data.text || ''))
        else if (type === 'image') parts.push('[图片]')
      }
      const joined = parts.join('').trim()
      if (joined !== '') return joined
    }
    const rawMessage = String((raw && raw.raw_message) || '')
    return rawMessage
      .replace(/\[CQ:[^\]]+\]/g, (match) => (/\[CQ:(?:video|image|forward),/i.test(match) ? '[媒体]' : ''))
      .trim()
  }

  /**
   * 处理一条抖音链接：解析 → 取详情 → 下载 → 发回 QQ。
   * @param {{ target: {kind: string, aweme_id?: string, short_url?: string, canonical?: string}, msgId: string }} job
   */
  async function deliverOneVideo(job) {
    const target = job.target
    const resolved = target.aweme_id
      ? { ok: true, aweme_id: String(target.aweme_id), canonical: String(target.canonical || '') }
      : await resolveAwemeTarget({ url: target.short_url })
    if (resolved.ok !== true) {
      return { ok: false, error: `链接解析失败：${resolved.error || '未知原因'}` }
    }
    const awemeId = resolved.aweme_id
    const key = `${job.msgId}|${awemeId}`
    if (state.recent[key]) return { ok: true, skipped: true, aweme_id: awemeId }

    const tools = discoverDouyinTools()
    if (tools.ok !== true) return { ok: false, error: tools.error }

    const detail = await fetchVideoDetail(awemeId, { tools })
    if (detail.ok !== true) return { ok: false, error: detail.error }
    const video = detail.video

    mkdirSync(tmpDir(), { recursive: true })
    const downloaded = await downloadVideo(video, { dir: tmpDir() })
    if (downloaded.ok !== true) return { ok: false, error: downloaded.error }
    try {
      const { onebot } = clients()
      const group = state.qq.kind === 'group'
      const sent = group
        ? await onebot.sendGroupVideo(state.qq.id, downloaded.file)
        : await onebot.sendPrivateVideo(state.qq.id, downloaded.file)
      if (sent.ok !== true) return { ok: false, error: `视频没发出：${sent.error || '未知原因'}` }
      const title = String(video.desc || '').replace(/\s+/g, ' ').slice(0, 80)
      const sizeMb = Math.round((downloaded.bytes / 1024 / 1024) * 10) / 10
      return { ok: true, aweme_id: awemeId, title, size_mb: sizeMb }
    } finally {
      try { rmSync(downloaded.file, { force: true }) } catch { /* ignore */ }
    }
  }

  /**
   * 一轮轮询：读绑定会话最近消息 → 识别新链接 → 下载并发回。
   */
  async function tick() {
    if (ticking) return
    if (state.enabled !== true || state.qq.id === '') return
    ticking = true
    try {
      const { onebot } = clients()
      const login = await onebot.loginInfo()
      if (login.ok !== true) {
        recordError(`QQ 侧连不上：${login.error || '未知原因'}`)
        return
      }
      const loginData = login.data !== null && typeof login.data === 'object' ? login.data : {}
      const selfUin = String(loginData.user_id || '')
      const history = state.qq.kind === 'group'
        ? await onebot.groupHistory(state.qq.id, 30)
        : await onebot.friendHistory(state.qq.id, 30)
      if (history.ok !== true) {
        recordError(`读 QQ 历史失败：${history.error || '未知原因'}`)
        return
      }
      const data = history.data !== null && typeof history.data === 'object' ? history.data : {}
      const messages = Array.isArray(data.messages) ? data.messages : []
      await processMessages(messages, selfUin)
      commit((draft) => {
        draft.stats.lastRunAt = new Date().toISOString()
        draft.lastError = ''
      })
    } catch (error) {
      recordError(`轮询出错：${String((error && error.message) || error)}`)
    } finally {
      ticking = false
    }
  }

  async function processMessages(messages, selfUin) {
    const primed = state.cursors.primed === true
    const lastTime = Number(state.cursors.lastTime) || 0
    const seenIds = new Set(Array.isArray(state.cursors.ids) ? state.cursors.ids.map(String) : [])
    /** @type {Array<{target: any, msgId: string, time: number}>} */
    const jobs = []
    let maxTime = lastTime
    const nextIds = [...seenIds]

    for (const raw of messages) {
      if (raw === null || typeof raw !== 'object') continue
      const time = Number(raw.time) || 0
      if (time > maxTime) maxTime = time
      const msgId = String(raw.message_id ?? raw.real_id ?? '')
      if (msgId !== '' && !seenIds.has(msgId)) nextIds.push(msgId)
      if (msgId === '' || seenIds.has(msgId)) continue
      const sender = raw.sender !== null && typeof raw.sender === 'object' ? raw.sender : {}
      const senderId = String(sender.user_id ?? raw.user_id ?? '')
      if (selfUin !== '' && senderId === selfUin) continue // 机器人自己发的
      if (state.ownerId !== '' && senderId !== state.ownerId) continue
      if (state.qq.kind === 'private' && state.ownerId === '' && senderId !== '' && senderId !== state.qq.id) continue
      const text = messageText(raw)
      if (text === '') continue
      const targets = extractTargets(text)
      if (targets.length === 0) continue
      // 首轮只记水位，不补发历史消息
      if (!primed) continue
      if (lastTime > 0 && time < lastTime) continue
      for (const target of targets.slice(0, 3)) {
        jobs.push({ target, msgId, time })
      }
    }

    // 先把水位/已见 id 落盘：即使这一轮发送失败，也不会把同一条消息无限重试到刷屏
    commit((draft) => {
      draft.cursors = {
        primed: true,
        lastTime: maxTime,
        ids: [...new Set(nextIds)].slice(-200),
      }
    })
    if (!primed) return

    let handled = 0
    for (const job of jobs) {
      if (handled >= MAX_PER_TICK) break
      handled += 1
      const result = await deliverOneVideo(job)
      if (result.ok === true) {
        if (result.skipped !== true) {
          const now = Date.now()
          commit((draft) => {
            draft.recent[`${job.msgId}|${result.aweme_id}`] = now
            draft.stats.sent += 1
            draft.stats.lastSentAt = new Date().toISOString()
            pushLog(draft, {
              at: new Date().toISOString(),
              ok: true,
              text: `[视频] ${String(result.title || result.aweme_id).slice(0, 80)}`,
              note: `已发到 QQ（${result.size_mb || '?'} MB）`,
            })
          })
        }
      } else {
        const note = String(result.error || '未知原因').slice(0, 240)
        commit((draft) => {
          draft.stats.errors += 1
          draft.lastError = note
          pushLog(draft, { at: new Date().toISOString(), ok: false, text: '[视频] 没发出', note })
        })
      }
    }
  }

  function startLoop() {
    if (timer !== null) clearInterval(timer)
    timer = setInterval(() => { void tick() }, state.pollMs)
    timer.unref?.()
    // 插件加载后先跑一次（不阻塞加载）
    setTimeout(() => { void tick() }, 1_500).unref?.()
  }

  function stopLoop() {
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  ctx.effect(() => {
    startLoop()
    return () => stopLoop()
  }, 'dsh-douyin-link-video: 轮询')

  /* ───────────────────────────── 工具 ───────────────────────────── */

  async function toolStatus() {
    const onebot = clients()
    const tools = discoverDouyinTools()
    const binding = state.qq.id === ''
      ? '还没绑定 QQ 会话'
      : `QQ ${state.qq.kind === 'group' ? '群' : '私聊'} ${state.qq.id}${state.qq.label ? `（${state.qq.label}）` : ''}`
    const lines = [
      `【douyin-link-video】v${VERSION} · ${state.enabled ? '已启用' : '未启用'} · ${binding}`,
      `只处理来自：${state.ownerId || (state.qq.kind === 'private' ? '对方（私聊自动）' : '（群聊未限制发送者）')}`,
      `轮询：每 ${Math.round(state.pollMs / 1000)} 秒 · 已发送 ${state.stats.sent} 条 · 失败 ${state.stats.errors} 次`,
      `QQ 侧：${onebot.baseUrl}${onebot.tokenFound ? '（有 token）' : '（没找到 accessToken）'}`,
      `抖音工具链：${tools.ok === true ? '就绪' : `不可用 —— ${tools.error}`}`,
    ]
    if (state.lastError) lines.push(`上次错误：${state.lastError}`)
    return {
      ok: true,
      state: publicState(state, {
        configured: state.qq.id !== '',
        onebot: { baseUrl: onebot.baseUrl, tokenFound: onebot.tokenFound },
        tools: tools.ok === true ? { ok: true, dir: tools.dir } : { ok: false, error: tools.error },
      }),
      text: lines.join('\n'),
    }
  }

  function runBind(args) {
    const kind = args.qq_kind === 'group' ? 'group' : 'private'
    const id = String(args.qq_id || '').trim()
    if (!/^\d{4,15}$/.test(id)) return { ok: false, error: 'qq_id 要是纯数字的 QQ 号 / 群号' }
    const owner = String(args.owner_id || '').trim()
    if (owner !== '' && !/^\d{4,15}$/.test(owner)) return { ok: false, error: 'owner_id 要是纯数字 QQ 号' }
    if (kind === 'group' && owner === '') {
      return { ok: false, error: '绑定群聊时必须给 owner_id（只处理这个 QQ 号发的链接，避免群里其他人刷屏）' }
    }
    commit((draft) => {
      draft.qq = { kind, id, label: String(args.label || '').trim().slice(0, 80) }
      draft.ownerId = owner !== '' ? owner : (kind === 'private' ? id : '')
      draft.cursors = { primed: false, lastTime: 0, ids: [] }
      draft.recent = {}
      draft.lastError = ''
      pushLog(draft, { at: new Date().toISOString(), ok: true, text: '已绑定 QQ 会话', note: `${kind} ${id}` })
    })
    return { ok: true, text: `已绑定 QQ ${kind === 'group' ? '群' : '私聊'} ${id}${owner ? `（只处理 ${owner} 发的链接）` : ''}。` }
  }

  async function runTest(args) {
    const target = await resolveAwemeTarget({ url: args.url, aweme_id: args.aweme_id, text: args.text })
    if (target.ok !== true) return { ok: false, error: target.error }
    if (args.dry === true) {
      const tools = discoverDouyinTools()
      if (tools.ok !== true) return { ok: false, error: tools.error }
      const detail = await fetchVideoDetail(target.aweme_id, { tools })
      if (detail.ok !== true) return { ok: false, error: detail.error }
      return {
        ok: true,
        video: detail.video,
        text: `【试运行】${String(detail.video.desc || '').slice(0, 80)}\n可下载地址：${detail.video.play_url ? '有' : '没有'}`,
      }
    }
    if (state.qq.id === '') return { ok: false, error: '还没绑定 QQ 会话 —— 先 bind' }
    const result = await deliverOneVideo({ target: { kind: 'video', aweme_id: target.aweme_id }, msgId: `test-${Date.now()}` })
    if (result.ok !== true) return { ok: false, error: result.error }
    return {
      ok: true,
      text: `已把视频发到绑定的 QQ 会话：${String(result.title || target.aweme_id).slice(0, 80)}（${result.size_mb || '?'} MB）`,
    }
  }

  function runConfig(args) {
    const patch = args.patch !== null && typeof args.patch === 'object' ? args.patch : {}
    if (patch.pollMs !== undefined) {
      const value = Math.round(Number(patch.pollMs))
      if (!Number.isFinite(value) || value < MIN_POLL_MS || value > MAX_POLL_MS) {
        return { ok: false, error: `pollMs 要在 ${MIN_POLL_MS / 1000}–${MAX_POLL_MS / 1000} 秒之间` }
      }
    }
    if (patch.ownerId !== undefined && !/^\d{0,15}$/.test(String(patch.ownerId))) {
      return { ok: false, error: 'ownerId 只能是纯数字 QQ 号（可留空）' }
    }
    commit((draft) => {
      if (patch.pollMs !== undefined) draft.pollMs = Math.round(Number(patch.pollMs))
      if (patch.ownerId !== undefined) draft.ownerId = String(patch.ownerId).trim()
      if (patch.onebotBaseUrl !== undefined) draft.settings.onebotBaseUrl = String(patch.onebotBaseUrl).trim().slice(0, 200)
    })
    if (patch.pollMs !== undefined) startLoop()
    return {
      ok: true,
      text: `配置已更新：轮询 ${Math.round(state.pollMs / 1000)}s，ownerId=${state.ownerId || '（空）'}，onebotBaseUrl=${state.settings.onebotBaseUrl || '（自动发现）'}`,
    }
  }

  ctx.effect(() => ctx.tools.register({
    name: 'douyin_link_video',
    description: [
      '🔗 抖音链接 → 视频：在绑定的 QQ 会话里发一条抖音视频链接，插件自动下载这条视频（MP4），并以 QQ 视频消息发回同一个会话（只存视频：不抽帧/不转写/不点赞/不评论）。',
      '第一次使用：先 `action=bind` 绑定 QQ 会话（qq_kind=private/group，qq_id=QQ号/群号；群聊还要 owner_id=你自己的 QQ 号），再 `action=enable enabled=true`。',
      '前提：本机 SnowLuma/QQ 桥接在线；本机已安装「刷抖音」插件（dsh-douyin-scroll）并登录过抖音（用来取抖音视频详情/下载地址）。',
      'action=status 看状态；action=test 用一条链接验证（dry=true 只取详情不发送）；action=config 改 pollMs / ownerId / onebotBaseUrl；action=log 看最近记录。',
      '只下载 MP4：不抽帧、不转写、不点赞、不评论、不发给其他人。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'bind', 'enable', 'test', 'config', 'log'],
          description: '要执行的操作。',
        },
        qq_kind: { type: 'string', enum: ['private', 'group'], description: 'bind：QQ 会话类型。' },
        qq_id: { type: 'string', description: 'bind：好友 QQ 号或群号（纯数字）。' },
        owner_id: { type: 'string', description: 'bind/config：只处理这个 QQ 号发的链接（群聊必填）。' },
        label: { type: 'string', description: 'bind：显示名（可选）。' },
        enabled: { type: 'boolean', description: 'enable：开/关自动轮询。' },
        url: { type: 'string', description: 'test：抖音视频链接（完整或 v.douyin.com 短链）。' },
        aweme_id: { type: 'string', description: 'test：抖音视频 ID（19 位数字）。' },
        text: { type: 'string', description: 'test：含抖音链接的一段文字。' },
        dry: { type: 'boolean', description: 'test：只取详情、不发送（默认 false）。' },
        limit: { type: 'number', description: 'log：最多几条（默认 10，最多 50）。' },
        patch: {
          type: 'object',
          properties: {
            pollMs: { type: 'number', description: `轮询间隔毫秒（${MIN_POLL_MS}–${MAX_POLL_MS}）` },
            ownerId: { type: 'string', description: '只处理这个 QQ 号发的链接（可留空）' },
            onebotBaseUrl: { type: 'string', description: '手动指定 OneBot HTTP 地址（可留空自动发现）' },
          },
          additionalProperties: true,
          description: 'config：要改的字段。',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: String((value && value.text) || (value && value.error) || '（没有结果）'),
      }],
    },
    isConcurrencySafe: () => false,
    execute: async (rawArgs) => {
      const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
      const action = String(args.action || 'status')
      try {
        if (action === 'status') return await toolStatus()
        if (action === 'bind') return runBind(args)
        if (action === 'enable') {
          if (typeof args.enabled !== 'boolean') return { ok: false, error: 'enable 需要 enabled: true/false' }
          commit((draft) => { draft.enabled = args.enabled })
          if (args.enabled) startLoop()
          else stopLoop()
          return { ok: true, text: `自动轮询已${args.enabled ? '开启' : '关闭'}。` }
        }
        if (action === 'test') {
          const result = await runTest(args)
          return result.ok === true ? result : { ok: false, error: result.error, text: `试运行失败：${result.error}` }
        }
        if (action === 'config') return runConfig(args)
        if (action === 'log') {
          const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50))
          const rows = (Array.isArray(state.log) ? state.log : []).slice(0, limit)
          if (rows.length === 0) return { ok: true, text: '还没有记录。' }
          return {
            ok: true,
            text: rows.map((row) => `${row.at.slice(11, 19)} ${row.ok ? '成功' : '失败'} ${row.text}${row.note ? `（${row.note}）` : ''}`).join('\n'),
          }
        }
        return { ok: false, error: `未知 action：${action}。可用：status / bind / enable / test / config / log。` }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error), text: `执行出错：${String((error && error.message) || error)}` }
      }
    },
  }), 'dsh-douyin-link-video: 工具 douyin_link_video')

  // 首次加载：保证运行目录存在；状态文件路径便于排查
  try {
    mkdirSync(join(stateFile(), '..'), { recursive: true })
    mkdirSync(tmpDir(), { recursive: true })
  } catch {
    /* 不阻塞加载 */
  }
  void existsSync
}
