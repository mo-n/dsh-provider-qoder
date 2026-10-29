# 插件配置

[English](./configuration.md) | 简体中文

Web profile 配置文件：`~/.dsh/profiles/web/cordis.patch.yml`。使用其他 profile 时替换 `web`。

在已有 Qoder 插件条目的 `config` 中按需配置，保留其他字段：

```yaml
- id: provider-qoder
  name: dsh-provider-qoder
  config:
    modelTransport: legacy
    requestCompression: false
    modelQueueMaxWaitMs: 3600000
    responseHeaderTimeoutMs: 60000
    streamIdleTimeoutMs: 300000
    preserveThinking: true
```

以下选项仅通过 YAML 配置，设置页面不提供编辑入口。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `modelTransport` | `legacy` | COSY 模型渠道；显式选择 `http` 使用 Bearer model-server 请求 |
| `requestCompression` | `false` | 设置为 `true` 开启 Zstd 请求体压缩 |
| `modelQueueMaxWaitMs` | `3600000`（60 分钟） | 单次逻辑模型调用的累计排队上限，多次排队共用，不包含正常生成耗时 |
| `responseHeaderTimeoutMs` | `60000`（1 分钟） | 等待模型请求 HTTP 响应头的时限 |
| `streamIdleTimeoutMs` | `300000`（5 分钟） | 流式响应等待下一段数据的时限，收到数据后重新计时 |
| `preserveThinking` | `true` | 后续请求携带历史 Qoder 推理内容；不控制思考开关或强度，不删除聊天记录 |

## 模型传输渠道

`modelTransport` 支持 `legacy` 和 `http`：

- `legacy`（默认）：通过 COSY 渠道发送模型请求。
- `http`：通过 Bearer model-server 渠道发送模型请求。

渠道仅通过 YAML 选择，设置页面不提供切换入口，发生错误时也不会自动切换渠道。
此配置仅影响模型请求；账号读取、模型发现、图片发布和联网搜索继续使用各自的传输路径。

例如，选择 HTTP 渠道并保持压缩关闭时，在已有插件条目中设置：

```yaml
  config:
    modelTransport: http
    requestCompression: false
```

## 请求体压缩

`requestCompression` 为布尔值，默认 `false`，对两种模型渠道均有效。在 YAML 中设置为
`true` 可开启 Zstd 请求体压缩。渠道选择与压缩开关相互独立，修改其中一个不会改变另一个。

开启后，满足条件且至少包含 4096 个字符的请求体会尝试压缩。较小请求、缺少原生 Zstd
支持或压缩失败时，发送未压缩请求。是否启用压缩由 YAML 配置决定。

仍支持以下可选环境变量，用于调整开启后的压缩参数：

| 环境变量 | 默认值 | 可选值 |
| --- | --- | --- |
| `QODER_ZSTD_REQUEST_BODY_MIN_CHARS` | `4096` | 正整数，表示请求体字符数阈值 |
| `QODER_ZSTD_REQUEST_BODY_LEVEL` | `1` | `1` 到 `22` 的整数 |

无效参数使用默认值；这两个环境变量均不会开启压缩。

## 配置生效

- 时间单位均为毫秒，要求正整数；排队上限最大为 `2147483647`。`0` 不表示无限等待。
- `preserveThinking` 与 `requestCompression` 使用布尔值 `true` / `false`，不加引号。
- 删除字段恢复默认值；以前通过 UI 保存的排队上限继续有效。
- 配置加载后对新调用生效，已开始的调用保持原配置。未自动加载时，重载对应 profile 或重启 DSH。
