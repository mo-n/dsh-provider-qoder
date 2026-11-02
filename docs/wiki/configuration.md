# Plugin Configuration

English | [简体中文](./configuration_CN.md)

Web profile file: `~/.dsh/profiles/web/cordis.patch.yml`. Replace `web` when using another profile.

Add options under the existing Qoder entry's `config`, preserving other fields:

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

These options are configured through YAML and have no editor in the plugin settings UI.

| Field | Default | Description |
| --- | --- | --- |
| `modelTransport` | `legacy` | Model transport channel, supports `legacy` and `http` |
| `requestCompression` | `false` | Set to `true` to enable Zstd request-body compression |
| `requestCompressionMinChars` | `4096` | Character threshold for attempting request-body compression |
| `requestCompressionLevel` | `1` | Zstd compression level, integer from `1` to `22` |
| `modelQueueMaxWaitMs` | `3600000` (60 minutes) | Cumulative queue wait per logical model call, shared across repeated queue entries; excludes normal generation time |
| `responseHeaderTimeoutMs` | `60000` (1 minute) | Time limit for receiving model request HTTP response headers |
| `streamIdleTimeoutMs` | `300000` (5 minutes) | SSE data idle timeout |
| `preserveThinking` | `true` | Whether requests include historical reasoning content |

- Time values are positive integers in milliseconds; the queue wait limit must not exceed `2147483647`. `0` does not mean unlimited waiting.
- Use unquoted booleans `true` / `false` for `preserveThinking` and `requestCompression`.

## Model transport

`modelTransport` supports `legacy` and `http`:

- `legacy` (default): sends model requests through the COSY channel.
- `http` (experimental): sends model requests through the `/v1/chat/completions` (OpenAI-compatible) endpoint.

For example, to select the HTTP channel while keeping compression disabled, set in the existing plugin entry:

```yaml
  config:
    modelTransport: http
    requestCompression: false
```

## Request-body compression

`requestCompression` is a boolean, defaults to `false`, and applies to both model channels. Set it to `true` in YAML to enable Zstd request-body compression. Channel selection and compression are independent; modifying one does not change the other.

When enabled, eligible request bodies with characters reaching `requestCompressionMinChars` will attempt compression, with the compression level specified by `requestCompressionLevel`.
