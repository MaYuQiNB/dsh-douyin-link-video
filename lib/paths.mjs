/**
 * lib/paths.mjs —— 目录约定（只依赖环境变量，不 import 任何 DSH 包；自检可脱离宿主跑）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 家目录：优先 `DSH_HOME`，否则 `~/.dsh`。 */
export function dshHome() {
  const fromEnv = String(process.env.DSH_HOME || '').trim()
  if (fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 本插件的运行数据目录（配置 / 状态 / 临时文件，不写进插件包目录）。 */
export function videoHome() {
  return join(dshHome(), 'douyin-link-video')
}

/** 状态文件。 */
export function stateFile() {
  return join(videoHome(), 'state.json')
}

/** 临时下载目录（QQ 发视频时用，发送完即删）。 */
export function tmpDir() {
  return join(videoHome(), 'tmp')
}

/** QQ 桥接（SnowLuma OneBot）的目录，用来发现 HTTP 地址与 access token。 */
export function qqBridgeDir() {
  return join(dshHome(), 'qq-bridge')
}

/** 「刷抖音」插件（dsh-douyin-scroll）的运行数据目录。 */
export function douyinHome() {
  return join(dshHome(), 'douyin-duty')
}
