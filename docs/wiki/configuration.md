# Plugin Configuration

English | [简体中文](./configuration_CN.md)

Web profile file: `~/.dsh/profiles/web/cordis.patch.yml`. Replace `web` when using another profile.

Add options under the existing Qoder entry's `config`, preserving other fields:

```yaml
- id: provider-qoder
  name: dsh-provider-qoder
  config:
    showModelRates: true
    modelTransport: legacy
    requestCompression: true
    requestCompressionMinChars: 4096
    requestCompressionLevel: 1
    modelQueueMaxWaitMs: 3600000
    responseHeaderTimeoutMs: 60000
    streamIdleTimeoutMs: 300000
    preserveThinking: true
    replaceSystemPrompt: true
```

These options are configured through YAML and have no editor in the plugin settings UI.

| Field | Default | Description |
| --- | --- | --- |
| `showModelRates` | `true` | Show billing rates and promotion tags in the conversation model dropdown. Set to `false` to hide them. Requires DSH `0.2.1-alpha.5` or later. |
| `modelTransport` | `legacy` | Model transport channel, supports `legacy` and `http` |
| `requestCompression` | `true` | Set to `false` to disable Zstd request-body compression |
| `requestCompressionMinChars` | `4096` | Character threshold for attempting request-body compression |
| `requestCompressionLevel` | `1` | Zstd compression level, integer from `1` to `22` |
| `modelQueueMaxWaitMs` | `3600000` (60 minutes) | Cumulative queue wait per logical model call, shared across repeated queue entries; excludes normal generation time |
| `responseHeaderTimeoutMs` | `60000` (1 minute) | Time limit for receiving model request HTTP response headers |
| `streamIdleTimeoutMs` | `300000` (5 minutes) | SSE data idle timeout |
| `preserveThinking` | `true` | Whether requests include historical reasoning content |
| `replaceSystemPrompt` | `true` | Replaces the default DSH system prompt. |

- Time values are positive integers in milliseconds; the queue wait limit must not exceed `2147483647`. `0` does not mean unlimited waiting.

## Model transport

`modelTransport` supports `legacy` and `http`:

- `legacy` (default): sends model requests through the COSY channel.
- `http` (experimental): sends model requests through the `/v1/chat/completions` (OpenAI-compatible) endpoint.

For example, to select the HTTP channel and disable compression, set in the existing plugin entry:

```yaml
  config:
    modelTransport: http
    requestCompression: false
```

## Request-body compression

`requestCompression` is a boolean that defaults to `true` and applies to both model channels. Set it to `false` in YAML to disable Zstd request-body compression. You can configure channel selection and compression independently.

When enabled, eligible request bodies with characters reaching `requestCompressionMinChars` will attempt compression, with the compression level specified by `requestCompressionLevel`.
