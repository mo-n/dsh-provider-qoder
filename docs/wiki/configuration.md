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
    modelQueueMaxWaitMs: 3600000
    responseHeaderTimeoutMs: 60000
    streamIdleTimeoutMs: 300000
    preserveThinking: true
```

These options are configured through YAML and have no editor in the plugin settings UI.

| Field | Default | Description |
| --- | --- | --- |
| `modelTransport` | `legacy` | COSY model transport; select `http` explicitly to use Bearer model-server requests |
| `requestCompression` | `false` | Opt in to Zstd request-body compression with `true` |
| `modelQueueMaxWaitMs` | `3600000` (60 minutes) | Cumulative queue wait per logical model call, shared across repeated queue entries; excludes normal generation time |
| `responseHeaderTimeoutMs` | `60000` (1 minute) | Time limit for receiving model request HTTP response headers |
| `streamIdleTimeoutMs` | `300000` (5 minutes) | Time limit for receiving the next stream chunk; resets when data arrives |
| `preserveThinking` | `true` | Includes historical Qoder reasoning content in subsequent requests; does not control reasoning mode or effort, or delete chat history |

## Feature settings

These settings are also available in **Settings → Qoder → Features**:

```yaml
  config:
    webSearchMode: auto
    imageSearchEnabled: true
    imageGenEnabled: true
```

| Field | Default | Behavior |
| --- | --- | --- |
| `webSearchMode` | `auto` | `auto`: Qoder search for Qoder models, ambient search otherwise; `always`: Qoder search regardless of model; `disabled`: no Qoder web search |
| `imageSearchEnabled` | `true` | Advertise and allow `ImageSearch`, which returns image and source metadata without downloading |
| `imageGenEnabled` | `true` | Advertise and allow `ImageGen`, which creates an image and delivers its original bytes as a durable DSH file attachment |

Switches affect new calls, independently of web search mode. Calls already in progress retain their transport and complete normally. Both tools use the selected Qoder service region and authorization; no other image provider is used as a fallback. `ImageGen` uses `ge3i`, defaults to `1024x1024`, and may consume subscription Credits. Generated files can be inspected with the host's existing `read_image` when the chat model supports image input. This plugin does not add a `read_image` switch.

The host must provide DSH tools, and generation additionally needs verbatim attachment storage with an execution-world file path mapping. Images are stored in the attachment store rather than directly in the workspace. Generation failures are not automatically resubmitted; after a delivery failure, do not generate again merely to retry a download or save.

## Model transport

`modelTransport` accepts `legacy` or `http`:

- `legacy` (default): sends model requests through the COSY channel.
- `http`: sends model requests through the Bearer model-server channel.

Select the channel in YAML; there is no channel selector in the settings UI. The
provider does not automatically switch channels after a failure. This setting
affects model requests; account reads, model discovery, image publication and web
search retain their own transport routes.

For example, to select HTTP while keeping compression disabled, edit the existing
plugin entry:

```yaml
  config:
    modelTransport: http
    requestCompression: false
```

## Request-body compression

`requestCompression` is a boolean, defaults to `false`, and applies to both model
channels. Set it to `true` in YAML to enable Zstd request-body compression. Channel
selection and compression are independent; enabling one does not change the other.

Compression is attempted for eligible request bodies of at least 4096 characters.
Smaller bodies, unavailable native Zstd support, or compression failures are sent
without compression. The YAML value controls whether compression is enabled.

The remaining optional environment variables tune compression after it is enabled:

| Variable | Default | Valid values |
| --- | --- | --- |
| `QODER_ZSTD_REQUEST_BODY_MIN_CHARS` | `4096` | Positive integer character threshold |
| `QODER_ZSTD_REQUEST_BODY_LEVEL` | `1` | Integer from `1` to `22` |

Invalid tuning values use their defaults. Neither variable enables compression.

## Applying configuration

- Time values are positive integers in milliseconds; the queue wait limit must not exceed `2147483647`. `0` does not mean unlimited waiting.
- Use unquoted booleans `true` / `false` for `preserveThinking` and `requestCompression`.
- Remove a field to restore its default. Queue limits previously saved through the UI remain valid.
- Loaded changes apply to new calls; existing calls retain their configuration. Reload the profile or restart DSH if changes are not loaded automatically.
