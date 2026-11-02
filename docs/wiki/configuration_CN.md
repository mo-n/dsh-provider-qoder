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
    requestCompressionMinChars: 4096
    requestCompressionLevel: 1
    modelQueueMaxWaitMs: 3600000
    responseHeaderTimeoutMs: 60000
    streamIdleTimeoutMs: 300000
    preserveThinking: true
```

以下选项仅通过 YAML 配置，设置页面不提供编辑入口。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `modelTransport` | `legacy` | 模型传输渠道，支持 `legacy` 和 `http` |
| `requestCompression` | `false` | 设置为 `true` 开启 Zstd 请求体压缩 |
| `requestCompressionMinChars` | `4096` | 触发压缩尝试的请求体字符数阈值 |
| `requestCompressionLevel` | `1` | Zstd 压缩等级，`1` 到 `22` 的整数 |
| `modelQueueMaxWaitMs` | `3600000`（60 分钟） | 单次逻辑模型调用的累计排队上限，多次排队共用，不包含正常生成耗时 |
| `responseHeaderTimeoutMs` | `60000`（1 分钟） | 等待模型请求 HTTP 响应头的时限 |
| `streamIdleTimeoutMs` | `300000`（5 分钟） | SSE 数据空闲超时时间 |
| `preserveThinking` | `true` | 请求是否携带历史推理内容 |

- 时间单位均为毫秒，要求正整数；排队上限最大为 `2147483647`。`0` 不表示无限等待。
- `preserveThinking` 与 `requestCompression` 使用布尔值 `true` / `false`，不加引号。

## 模型传输渠道

`modelTransport` 支持 `legacy` 和 `http`：

- `legacy`（默认）：通过 COSY 渠道发送模型请求。
- `http`（试验功能）：通过`/v1/chat/completions`（openAI风格）接口发送模型请求。

例如，选择 HTTP 渠道并保持压缩关闭时，在已有插件条目中设置：

```yaml
  config:
    modelTransport: http
    requestCompression: false
```

## 请求体压缩

`requestCompression` 为布尔值，默认 `false`，对两种模型渠道均有效。在 YAML 中设置为
`true` 可开启 Zstd 请求体压缩。渠道选择与压缩开关相互独立，修改其中一个不会改变另一个。

开启后，满足条件且字符数达到 `requestCompressionMinChars` 的请求体会尝试压缩，
压缩等级由 `requestCompressionLevel` 指定。
