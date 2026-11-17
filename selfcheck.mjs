#!/usr/bin/env node
/**
 * selfcheck.mjs —— dsh-qq-douyin-video 的离线自检（不联网、不起子进程、不碰真实 $DSH_HOME）。
 *
 * 覆盖：
 *   1. lib/store.mjs：默认值 / 规整（poll 夹紧、qq、ownerId、recent 上限、log 上限）/ 读写往返 / publicState
 *   2. lib/links.mjs：链接识别、短链解析（注入假 fetch）、canonical URL
 *   3. lib/douyin.mjs：detail 解析、pickJson、工具链发现（假 DSH_HOME + 假 profile + 假 venv）
 *   4. 包契约静态检查：工具名 / action 列表 / bundle patch / cordis id
 *
 * 跑法：node selfcheck.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createOneBot, normalizeOneBotResponse } from './lib/onebot.mjs'
import { canonicalVideoUrl, extractTargets, isDouyinUrl, parseTarget, resolveShortLink } from './lib/links.mjs'
import { discoverDouyinTools, parseVideoDetail, pickJson } from './lib/douyin.mjs'
import {
  MAX_LOG,
  MAX_RECENT,
  defaultState,
  loadState,
  normalizeState,
  publicState,
  pushLog,
  saveState,
} from './lib/store.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
let passed = 0
const failures = []

function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { passed += 1; return }
  failures.push(`${name}\n  实际: ${a}\n  期望: ${e}`)
}
function truthy(name, actual) {
  if (actual) { passed += 1; return }
  failures.push(`${name}\n  实际: ${JSON.stringify(actual)}`)
}
function contains(name, haystack, needle) {
  if (String(haystack).includes(needle)) { passed += 1; return }
  failures.push(`${name}\n  没找到: ${needle}`)
}

/** 在临时目录里造一个假的 DSH_HOME（profile + 假 dsh-douyin-scroll + 假 venv）。 */
function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'qqdy-video-selfcheck-'))
  const pluginDir = join(home, 'workspace', 'dsh-douyin-scroll')
  mkdirSync(join(pluginDir, 'tools'), { recursive: true })
  writeFileSync(join(pluginDir, 'tools', 'api-comments.py'), '# fake\n')
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({
    dependencies: { 'dsh-douyin-scroll': `link:${pluginDir}` },
  }))
  const python = join(home, 'douyin-duty', '.venv', 'Scripts', 'python.exe')
  mkdirSync(dirname(python), { recursive: true })
  writeFileSync(python, '')
  return { home, pluginDir, python }
}

function storeTests() {
  const base = defaultState()
  eq('defaultState 字段齐全', Object.keys(base).sort(), ['cursors', 'enabled', 'lastError', 'log', 'ownerId', 'pollMs', 'qq', 'recent', 'settings', 'stats', 'version'].sort())
  eq('默认未启用', base.enabled, false)
  eq('默认私聊空绑定', base.qq, { kind: 'private', id: '', label: '' })

  const dirty = normalizeState({ pollMs: 1, qq: { kind: 'group', id: 12345, label: ' 群 ' }, ownerId: ' 999 ', recent: { a: 1 }, log: 'x' })
  eq('pollMs 低于下限夹到 MIN', dirty.pollMs, 8000)
  eq('qq 规整', dirty.qq, { kind: 'group', id: '12345', label: '群' })
  eq('ownerId 去空格', dirty.ownerId, '999')
  eq('log 非数组回空', dirty.log, [])
  eq('recent 规整为对象', Object.keys(dirty.recent), ['a'])

  const many = Object.fromEntries(Array.from({ length: MAX_RECENT + 20 }, (_, i) => [`k${i}`, i + 1]))
  eq('recent 最多保留 MAX_RECENT', Object.keys(normalizeState({ recent: many }).recent).length, MAX_RECENT)

  const state = defaultState()
  for (let i = 0; i < MAX_LOG + 5; i++) pushLog(state, { at: new Date().toISOString(), ok: i % 2 === 0, text: `t${i}`, note: '' })
  eq('log 最多保留 MAX_LOG', state.log.length, MAX_LOG)

  const home = mkdtempSync(join(tmpdir(), 'qqdy-video-state-'))
  try {
    const file = join(home, 'state.json')
    const loaded = loadState(file)
    eq('状态文件不存在回默认', loaded.state.enabled, false)
    const saved = saveState({ ...defaultState(), enabled: true, qq: { kind: 'private', id: '10001' } }, file)
    eq('saveState 返回规整结果', saved.enabled, true)
    const again = loadState(file).state
    eq('读写往返保持字段', [again.enabled, again.qq.id], [true, '10001'])
    writeFileSync(file, '{broken json')
    const broken = loadState(file)
    eq('坏状态文件回默认并标记 recovered', [broken.state.enabled, broken.recovered], [false, true])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }

  const pub = publicState(normalizeState({ enabled: true, qq: { kind: 'private', id: '42' } }), { configured: true })
  eq('publicState 不泄漏未声明字段', Object.prototype.hasOwnProperty.call(pub, 'recent'), false)
  eq('publicState 含配置状态', [pub.enabled, pub.configured, pub.qq.id], [true, true, '42'])
}

function linkTests() {
  eq('完整链接识别', parseTarget('https://www.douyin.com/video/7707770041366954981').aweme_id, '7707770041366954981')
  eq('modal_id 识别', parseTarget('https://www.douyin.com/user/x?modal_id=7707770041366954981').aweme_id, '7707770041366954981')
  eq('纯 aweme_id 识别', parseTarget('7707770041366954981').aweme_id, '7707770041366954981')
  eq('短链识别', parseTarget('https://v.douyin.com/abc123/').kind, 'short')
  truthy('非抖音链接不认', parseTarget('https://example.com/video/123') === null || parseTarget('https://example.com/video/123').kind === 'unknown')
  eq('canonical URL', canonicalVideoUrl('7707770041366954981'), 'https://www.douyin.com/video/7707770041366954981')
  eq('从文字里提目标', extractTargets('看这个 https://www.douyin.com/video/7707770041366954981 哈哈').length, 1)
  eq('isDouyinUrl', [isDouyinUrl('https://www.douyin.com/video/1'), isDouyinUrl('https://example.com')], [true, false])

  const okFetch = async () => ({
    status: 302,
    headers: { get: (name) => (name.toLowerCase() === 'location' ? 'https://www.douyin.com/video/7707770041366954981' : null) },
    text: async () => '',
    url: 'https://www.douyin.com/video/7707770041366954981',
  })
  return (async () => {
    const ok = await resolveShortLink('https://v.douyin.com/abc/', { fetchImpl: okFetch })
    eq('短链 302 解析成功', [ok.ok, ok.aweme_id], [true, '7707770041366954981'])

    const htmlFetch = async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => '<html>.../video/7707770041366954981?...</html>',
      url: 'https://www.iesdouyin.com/share/video/7707770041366954981/',
    })
    const html = await resolveShortLink('https://v.douyin.com/abc/', { fetchImpl: htmlFetch })
    eq('短链 HTML 兜底解析', [html.ok, html.aweme_id], [true, '7707770041366954981'])

    const failFetch = async () => { throw new Error('network down') }
    const failed = await resolveShortLink('https://v.douyin.com/abc/', { fetchImpl: failFetch })
    eq('短链异常不抛、返回失败', failed.ok, false)
  })()
}

function douyinTests() {
  const detail = parseVideoDetail({
    aweme_detail: {
      aweme_id: '7707770041366954981',
      desc: '测试标题 #tag',
      author: { nickname: '作者', sec_uid: 'SEC' },
      statistics: { digg_count: 12, comment_count: 3 },
      video: {
        duration: 6100,
        play_addr: { url_list: ['https://cdn.example/v.mp4'] },
        cover: { url_list: ['https://cdn.example/c.jpg'] },
      },
    },
  })
  eq('detail 解析：基础字段', [detail.aweme_id, detail.desc, detail.author, detail.digg, detail.comment_count, detail.duration_ms], ['7707770041366954981', '测试标题 #tag', '作者', 12, 3, 6100])
  eq('detail 解析：可下载地址与封面', [detail.play_url, detail.cover], ['https://cdn.example/v.mp4', 'https://cdn.example/c.jpg'])
  eq('detail 解析：空输入返回 null', parseVideoDetail(null), null)

  eq('pickJson：从日志里抠 JSON', pickJson('log line\n{"a":1}\n'), { a: 1 })
  eq('pickJson：无 JSON 返回 null', pickJson('no json'), null)

  return (async () => {
    const fake = makeFakeHome()
    try {
      const found = discoverDouyinTools({ DSH_HOME: fake.home })
      eq('工具链发现：找到插件目录', found.ok, true)
      eq('工具链发现：Python 路径', found.python, fake.python)
      const missing = discoverDouyinTools({ DSH_HOME: join(fake.home, 'nope') })
      eq('工具链发现：找不到时如实报错', missing.ok, false)
      truthy('工具链发现：错误信息可读', /dsh-douyin-scroll/.test(missing.error))
    } finally {
      rmSync(fake.home, { recursive: true, force: true })
    }
  })()
}

function onebotTests() {
  eq('OneBot 信封：成功', normalizeOneBotResponse({ status: 'ok', retcode: 0, data: { x: 1 } }), { ok: true, data: { x: 1 } })
  eq('OneBot 信封：业务失败', normalizeOneBotResponse({ status: 'failed', retcode: 100, wording: 'bad' }).ok, false)
  const client = createOneBot({ baseUrl: 'http://127.0.0.1:9', token: 't' })
  eq('OneBot 客户端有 sendPrivateVideo', typeof client.sendPrivateVideo, 'function')
  eq('OneBot 客户端有 sendGroupVideo', typeof client.sendGroupVideo, 'function')
}

function staticTests() {
  const index = readFileSync(join(ROOT, 'index.js'), 'utf8')
  contains('工具名注册', index, "name: 'qq_douyin_video'")
  for (const action of ['status', 'bind', 'enable', 'test', 'config', 'log']) {
    contains(`action ${action}`, index, `action === '${action}'`)
  }
  contains('只发视频（sendPrivateVideo）', index, 'sendPrivateVideo')
  contains('不抽帧（无 extractFramesAndAudio）', !index.includes('extractFramesAndAudio'), true)

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  eq('package name', pkg.name, 'dsh-qq-douyin-video')
  eq('package 声明 bundle patch', pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, './cordis.patch.yml')
  truthy('cordis.patch.yml 存在', existsSync(join(ROOT, pkg.dsh.bundle.patch)))
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  contains('patch id 与包名对齐', patch, 'name: dsh-qq-douyin-video')
  contains('README 存在', readFileSync(join(ROOT, 'README.md'), 'utf8'), 'qq-douyin-video')
}

async function main() {
  storeTests()
  await linkTests()
  await douyinTests()
  onebotTests()
  staticTests()
  const total = passed + failures.length
  if (failures.length > 0) {
    console.log(`\n❌ ${failures.length} 条失败：\n`)
    for (const failure of failures) console.log(`- ${failure}\n`)
    console.log(`结果：${passed} passed, ${failures.length} failed（共 ${total} 条）`)
    process.exit(1)
  }
  console.log(`✅ 全部通过：${passed} passed, 0 failed（共 ${total} 条）`)
}

main().catch((error) => {
  console.error('自检脚本自身出错：', error)
  process.exit(1)
})
