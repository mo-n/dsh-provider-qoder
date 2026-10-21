# 插件配置

[English](./configuration.md) | 简体中文

Web profile 配置文件：`~/.dsh/profiles/web/cordis.patch.yml`。使用其他 profile 时替换 `web`。

在已有 Qoder 插件条目的 `config` 中按需配置，保留其他字段：

```yaml
- id: provider-qoder
  name: dsh-provider-qoder
  config:
    modelQueueMaxWaitMs: 3600000
    responseHeaderTimeoutMs: 60000
    streamIdleTimeoutMs: 300000
    preserveThinking: true
```

以下选项仅通过 YAML 配置，设置页面不提供编辑入口。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `modelQueueMaxWaitMs` | `3600000`（60 分钟） | 单次逻辑模型调用的累计排队上限，多次排队共用，不包含正常生成耗时 |
| `responseHeaderTimeoutMs` | `60000`（1 分钟） | 等待模型请求 HTTP 响应头的时限 |
| `streamIdleTimeoutMs` | `300000`（5 分钟） | 流式响应等待下一段数据的时限，收到数据后重新计时 |
| `preserveThinking` | `true` | 后续请求携带历史 Qoder 推理内容；不控制思考开关或强度，不删除聊天记录 |

- 时间单位均为毫秒，要求正整数；排队上限最大为 `2147483647`。`0` 不表示无限等待。
- `preserveThinking` 使用布尔值 `true` / `false`，不加引号。
- 删除字段恢复默认值；以前通过 UI 保存的排队上限继续有效。
- 配置加载后对新调用生效，已开始的调用保持原配置。未自动加载时，重载对应 profile 或重启 DSH。
