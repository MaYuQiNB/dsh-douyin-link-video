# dsh-douyin-link-video ｜ 抖音链接 → 视频：QQ 里发链接，自动收到视频

> 一个 [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) 插件：**把「抖音链接」变成「视频文件」**——
> 在 QQ 聊天里发一条抖音视频链接，插件自动下载这条视频（MP4），并以 QQ 视频消息发回同一个会话；
> 不用点开浏览器，也不用问 AI。**只存视频**：不抽帧、不转写、不点赞、不评论。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#许可证)

## 它做什么

```text
你在 QQ 里发：   https://v.douyin.com/xxxxxx/
        ↓  （插件轮询这个 QQ 会话）
     识别抖音链接 → 取视频详情 → 下载 MP4
        ↓
QQ 里收到：      📹 一条可直接播放的视频消息
```

- **只下载 MP4**：不抽帧、不转写、不点赞、不评论、不发给其他人。
- 完全本地运行：QQ 侧走本机 SnowLuma（OneBot v11 HTTP），抖音侧复用本机已登录的
  「刷抖音」插件（[dsh-douyin-scroll](https://github.com/NEWJO123/dsh-douyin-scroll)）签名接口。
- 支持私聊和群聊；群聊可以限制「只处理某个人发的链接」。
- 自带去重/水位：同一条消息不会重复发送，插件重启也不会补发历史消息。

## 前提

| 依赖 | 说明 |
|---|---|
| DSH | `>= 0.1.7-rc.1`（插件是 bundle 形态） |
| Node | `>= 18` |
| QQ 桥接 | 本机运行 [SnowLuma](https://github.com/)（或任意兼容 OneBot v11 HTTP 的服务），且有可用的 QQ 机器人账号；插件从 `$DSH_HOME/qq-bridge/config.json` 的 `snowluma.httpUrl` / `accessToken` 自动发现连接参数 |
| 抖音工具链 | 本机安装并登录过 [`dsh-douyin-scroll`](https://github.com/NEWJO123/dsh-douyin-scroll)（刷抖音插件）。本插件复用它已验证的 `tools/cdp-fetch.mjs`（已登录无头页面里带签名取 JSON）和 venv；找不到会明确报错 |

> 为什么需要「刷抖音」插件：抖音的视频详情接口需要浏览器内签名（`a_bogus` 等），
> 自己在外面拼签名会被 403。本插件不重复造轮子，直接复用已经跑通的登录态 + 脚本。

## 安装

```bash
# 1）确保这两个插件已装好并登录
#    - dsh-douyin-scroll（刷抖音）：装好后进 设置 → 刷抖音 → 装主依赖 → 扫码登录
#    - 本插件
dsh plugin --profile desktop add link:/path/to/dsh-douyin-link-video

# 2）重启 DSH（bundle 层要重启才组装）
```

重启后工具 `douyin_link_video` 出现在所有 Agent 的工具列表里。

## 使用

插件是**工具驱动**的（没有设置页），首次三步：

```jsonc
// ① 绑定 QQ 会话（私聊）：之后只处理这个会话里对方发的链接
{ "action": "bind", "qq_kind": "private", "qq_id": "3806242644", "label": "我的大号" }

// ② 打开自动轮询
{ "action": "enable", "enabled": true }

// ③ 用一条链接验证（不发送：dry=true；去掉 dry 就真的发一条视频到绑定的 QQ）
{ "action": "test", "url": "https://www.douyin.com/video/7707770041366954981", "dry": true }
```

群聊用法（必须给 `owner_id`，只处理这个人发的链接）：

```jsonc
{ "action": "bind", "qq_kind": "group", "qq_id": "123456789", "owner_id": "3806242644" }
```

其他 action：

| action | 说明 |
|---|---|
| `status` | 启用状态、绑定、轮询间隔、已发送/失败次数、QQ 侧与抖音工具链是否就绪 |
| `log` | 最近记录（`limit`，默认 10） |
| `config` | 改 `pollMs`（8000–120000）/ `ownerId` / `onebotBaseUrl`（一般不用改，自动发现） |

状态文件：`$DSH_HOME/douyin-link-video/state.json`；临时 MP4 在 `$DSH_HOME/douyin-link-video/tmp/`，发完即删。
**不会把 access token 写进状态文件或日志。**

## 工作原理

```
┌─ QQ（SnowLuma / OneBot v11 HTTP）─────────────┐
│  每 pollMs 读一次绑定会话最近 30 条消息        │
│  跳过机器人自己发的；群聊只认 ownerId 的链接   │
└───────────────┬──────────────────────────────┘
                │ 新消息里出现 douyin.com/video 或 v.douyin.com 短链
                ▼
┌─ 抖音（复用 dsh-douyin-scroll）───────────────┐
│  cdp-fetch.mjs：已登录无头页里带签名取详情     │
│  → play_addr.url_list[0]（mp4 地址）          │
│  → Node fetch 带 UA/Referer 下载到本地         │
└───────────────┬──────────────────────────────┘
                ▼
        send_private_msg / send_group_msg
        message: [{ type: 'video', data: { file } }]
        → 你在 QQ 里直接看到视频
```

## 安全与边界

- **只读 QQ 历史 + 只往绑定会话发视频**，不点开别人的会话、不改资料、不点赞评论。
- **只在有链接时动作**：普通聊天消息完全忽略。
- **去重**：`message_id|aweme_id` 记在 `recent` 里；同一条消息最多处理一次。
- **不存敏感信息**：OneBot 的 access token 每轮从 `qq-bridge/config.json` 现读，不落盘、不写日志。
- **个人自用定位**：Cookie / 登录态属于你自己，请遵守抖音与 QQ 的用户协议；因自动化操作导致的账号风险由使用者自行承担。

## 已知限制

- 图文作品（note）可能没有 `play_addr`，会明确报「没有可下载地址」。
- 依赖「刷抖音」插件的登录态：抖音掉登录后本插件也会报错，需去刷抖音设置页重新扫码。
- 短链解析失败时（抖音风控）会记一条失败日志，可改发完整链接。
- 只支持视频消息；不支持直播 / 合集 / 网页里播放的付费内容。
- 每轮最多处理 3 条带链接的消息，避免一次刷屏。

## 自检（离线）

```bash
node selfcheck.mjs
```

不联网、不起子进程、不碰真实 `$DSH_HOME`（用临时目录 + 注入假 fetch / 假 home）。
覆盖：状态读写与规整、链接识别与短链解析、抖音 detail 解析、工具链发现、OneBot 响应规整、包契约静态检查。

## 许可证

[MIT](./LICENSE) © 2026 MaYuQiNB

## 致谢

- 抖音详情/签名：复用 [`dsh-douyin-scroll`](https://github.com/NEWJO123/dsh-douyin-scroll)（MIT）已验证的工具链。
- QQ 侧：SnowLuma / OneBot v11 HTTP。
- 宿主：DeepSeek Harness。
