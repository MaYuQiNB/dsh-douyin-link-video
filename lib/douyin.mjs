/**
 * lib/douyin.mjs —— 取抖音视频「详情 + 可下载 mp4 地址」并下载到本地。
 *
 * 依赖：本机已安装「刷抖音」插件（dsh-douyin-scroll）并登录过抖音 —— 复用它已经验证过的
 * 签名接口脚本（tools/cdp-fetch.mjs 在已登录的无头页面里带签名取 JSON）和 venv。
 * 找不到时**如实报错**，不猜路径。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, douyinHome } from './paths.mjs'

/** detail 接口的公共参数（与「刷抖音」的 tools/api-comments.py 对齐）。 */
const COMMON = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  pc_client_type: '1',
  version_code: '190500',
  version_name: '19.5.0',
  cookie_enabled: 'true',
  screen_width: '1920',
  screen_height: '1080',
  browser_language: 'zh-CN',
  browser_platform: 'Win32',
  browser_name: 'Chrome',
  browser_version: '141.0.0.0',
  engine_name: 'Blink',
  engine_version: '141.0.0.0',
  os_name: 'Windows',
  os_version: '10',
  platform: 'PC',
}

/** 下载视频时伪装成浏览器。 */
const DOWNLOAD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

function readText(file) {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return ''
  }
}

function readJson(file) {
  const text = readText(file)
  if (text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 找「刷抖音」插件目录 / venv python / node：
 *   ① `DSH_PROFILE_DIR` → profile package.json 里 dsh-douyin-scroll 的 link: 路径
 *   ② `$DSH_HOME/profiles/*​/package.json` 找同一个依赖
 *   ③ `DOUYIN_SCROLL_DIR` 环境变量可直接指定
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ok: true, dir: string, python: string, node: string, stateHome: string, source: string }
 *          | { ok: false, error: string, tried?: string[] }}
 */
export function discoverDouyinTools(env = process.env) {
  const home = env.DSH_HOME && String(env.DSH_HOME).trim() !== '' ? String(env.DSH_HOME).trim() : dshHome()
  const marker = join('tools', 'api-comments.py')
  /** @type {string[]} */
  const candidates = []
  let source = ''

  const fromEnvDir = String(env.DOUYIN_SCROLL_DIR || '').trim()
  if (fromEnvDir !== '') {
    candidates.push(fromEnvDir)
    source = 'DOUYIN_SCROLL_DIR'
  }

  const dirFromProfile = (profileDir) => {
    if (!profileDir) return ''
    const pkg = readJson(join(profileDir, 'package.json'))
    const dep = pkg && pkg.dependencies ? pkg.dependencies['dsh-douyin-scroll'] : undefined
    if (typeof dep !== 'string' || !dep.startsWith('link:')) return ''
    return dep.slice('link:'.length)
  }

  const fromProfileEnv = dirFromProfile(String(env.DSH_PROFILE_DIR || ''))
  if (fromProfileEnv !== '') {
    candidates.push(fromProfileEnv)
    if (source === '') source = 'DSH_PROFILE_DIR'
  }
  try {
    const profilesRoot = join(home, 'profiles')
    if (existsSync(profilesRoot)) {
      for (const name of readdirSync(profilesRoot)) {
        const dir = dirFromProfile(join(profilesRoot, name))
        if (dir !== '') candidates.push(dir)
      }
      if (source === '' && candidates.length > 0) source = 'profiles/*/package.json'
    }
  } catch {
    /* 读不到 profiles 就算了 */
  }

  const found = candidates.find((dir) => existsSync(join(dir, marker)))
  if (found === undefined) {
    return {
      ok: false,
      error: '找不到「刷抖音」插件目录（dsh-douyin-scroll）：请先安装它并登录抖音，或用环境变量 DOUYIN_SCROLL_DIR 指向插件目录',
      tried: candidates,
    }
  }

  const pythonCandidates = [
    join(home, 'douyin-duty', '.venv', 'Scripts', 'python.exe'),
    join(home, 'douyin-duty', '.venv', 'bin', 'python'),
  ]
  const python = pythonCandidates.find((file) => existsSync(file)) || ''
  if (python === '') {
    return {
      ok: false,
      error: '找不到「刷抖音」的 Python 环境（.venv）——打开设置 → 刷抖音，点一次「装主依赖」',
      dir: found,
    }
  }

  return {
    ok: true,
    dir: found,
    python,
    node: process.execPath,
    stateHome: join(home, 'douyin-duty'),
    source,
  }
}

/**
 * 跑子进程，超时杀掉；永不抛。
 * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function runProcess(command, args = [], options = {}) {
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess | null} */
    let child = null
    let finished = false
    let timer = null
    const finish = (payload) => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: '', timedOut: false, ...payload })
    }
    try {
      child = spawn(command, args, {
        cwd: options.cwd || process.cwd(),
        windowsHide: true,
        env: { ...process.env, ...(options.env || {}) },
      })
    } catch (error) {
      finish({ stderr: String((error && error.message) || error) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => finish({ stderr: String((error && error.message) || error) }))
    child.on('close', (code) => finish({ code: Number(code) || 0, stdout, stderr }))
    const timeoutMs = Math.max(5_000, Math.min(Number(options.timeoutMs) || 120_000, 600_000))
    timer = setTimeout(() => {
      try { child?.kill() } catch { /* ignore */ }
      finish({ stdout, stderr, timedOut: true })
    }, timeoutMs)
    timer.unref?.()
  })
}

/** 从混合输出里抠出最后一个完整 JSON 对象（脚本可能先打日志）。 */
export function pickJson(text) {
  const source = String(text || '')
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(source.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * 解析 detail 接口 JSON → 精简视频信息。
 * @param {any} json
 */
export function parseVideoDetail(json) {
  if (json === null || typeof json !== 'object') return null
  const detail = json.aweme_detail || json.aweme || null
  if (detail === null || typeof detail !== 'object') return null
  const awemeId = String(detail.aweme_id || '').trim()
  if (awemeId === '') return null
  const statistics = detail.statistics !== null && typeof detail.statistics === 'object' ? detail.statistics : {}
  const author = detail.author !== null && typeof detail.author === 'object' ? detail.author : {}
  const video = detail.video !== null && typeof detail.video === 'object' ? detail.video : {}
  const coverList = video.cover && Array.isArray(video.cover.url_list) ? video.cover.url_list : []
  const originList = video.origin_cover && Array.isArray(video.origin_cover.url_list) ? video.origin_cover.url_list : []
  const playAddr = video.play_addr !== null && typeof video.play_addr === 'object' ? video.play_addr : {}
  const playList = Array.isArray(playAddr.url_list) ? playAddr.url_list : []
  const downloadAddr = video.download_addr !== null && typeof video.download_addr === 'object' ? video.download_addr : {}
  const downloadList = Array.isArray(downloadAddr.url_list) ? downloadAddr.url_list : []
  return {
    aweme_id: awemeId,
    desc: String(detail.desc || '').trim(),
    author: String(author.nickname || '').trim(),
    author_sec_uid: String(author.sec_uid || '').trim(),
    digg: Number(statistics.digg_count) || 0,
    comment_count: Number(statistics.comment_count) || 0,
    duration_ms: Number(video.duration) || 0,
    cover: String(coverList[0] || originList[0] || ''),
    play_url: String(playList[0] || downloadList[0] || ''),
  }
}

/**
 * 取一条视频的详情（含 play_url）。~1–3 秒。
 * @param {string} awemeId
 * @param {{ tools?: ReturnType<typeof discoverDouyinTools>, timeoutMs?: number }} [options]
 */
export async function fetchVideoDetail(awemeId, options = {}) {
  const tools = options.tools || discoverDouyinTools()
  if (tools.ok !== true) return { ok: false, error: tools.error }
  const query = Object.entries({ ...COMMON, aweme_id: String(awemeId) })
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
  const result = await runProcess(tools.node, [join(tools.dir, 'tools', 'cdp-fetch.mjs'), '--path', `/aweme/v1/web/aweme/detail/?${query}`], {
    cwd: tools.dir,
    env: { DOUYIN_HOME: tools.stateHome },
    timeoutMs: Math.max(15_000, Math.min(Number(options.timeoutMs) || 120_000, 180_000)),
  })
  if (result.timedOut) return { ok: false, error: '取视频详情超时（抖音页面没响应）' }
  const json = pickJson(result.stdout)
  const video = parseVideoDetail(json)
  if (video === null) {
    return { ok: false, error: `没取到视频详情：${(result.stderr || result.stdout || '').replace(/\s+/g, ' ').slice(-160) || '无输出'}` }
  }
  return { ok: true, video }
}

/**
 * 下载视频到本地文件。
 * @param {{ aweme_id?: string, play_url?: string }} video
 * @param {{ dir: string, filename?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ ok: true, file: string, bytes: number } | { ok: false, error: string }>}
 */
export async function downloadVideo(video, options = {}) {
  const url = String((video && video.play_url) || '').trim()
  if (url === '') return { ok: false, error: '这条没有可下载地址（可能是图文，或视频已删除/被限流）' }
  const dir = String(options.dir || '')
  if (dir === '') return { ok: false, error: '没给临时目录' }
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const filename = String(options.filename || `${(video && video.aweme_id) || Date.now()}.mp4`)
  const target = join(dir, filename)
  const timeoutMs = Math.max(10_000, Math.min(Number(options.timeoutMs) || 180_000, 300_000))
  try {
    const response = await fetchImpl(url, {
      headers: {
        'user-agent': DOWNLOAD_UA,
        referer: 'https://www.douyin.com/',
        accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
      },
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined,
    })
    if (!response.ok) return { ok: false, error: `下载视频失败：HTTP ${response.status}` }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 1024) return { ok: false, error: `下载的视频太小（${buffer.length} 字节），可能被风控了` }
    writeFileSync(target, buffer)
    return { ok: true, file: target, bytes: buffer.length }
  } catch (error) {
    const name = String((error && error.name) || '')
    const reason = name === 'TimeoutError' || name === 'AbortError' ? '下载超时' : String((error && error.message) || error)
    return { ok: false, error: `下载视频失败：${reason}` }
  }
}

/** 读 QQ 桥接（SnowLuma OneBot）的 HTTP 地址与 access token —— 只读，不落盘。 */
export function readOneBotConfig() {
  const file = join(dshHome(), 'qq-bridge', 'config.json')
  const cfg = readJson(file) || {}
  const snow = cfg.snowluma !== null && typeof cfg.snowluma === 'object' ? cfg.snowluma : {}
  return {
    exists: Object.keys(cfg).length > 0,
    baseUrl: String(snow.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    accessToken: String(snow.accessToken || ''),
  }
}

/** 本机是否已安装「刷抖音」插件（给状态展示用，不启动浏览器）。 */
export function douyinReady() {
  const tools = discoverDouyinTools()
  return tools.ok === true ? { ok: true, dir: tools.dir } : { ok: false, error: tools.error }
}

/** 「刷抖音」的数据目录（给状态展示用）。 */
export function douyinStateHome() {
  return douyinHome()
}
