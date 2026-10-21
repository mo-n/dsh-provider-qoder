# Plugin Configuration

English | [简体中文](./configuration_CN.md)

Web profile file: `~/.dsh/profiles/web/cordis.patch.yml`. Replace `web` when using another profile.

Add options under the existing Qoder entry's `config`, preserving other fields:

```yaml
- id: provider-qoder
  name: dsh-provider-qoder
  config:
    modelQueueMaxWaitMs: 3600000
    responseHeaderTimeoutMs: 60000
    streamIdleTimeoutMs: 300000
    preserveThinking: true
```

These options are configured through YAML and have no editor in the plugin settings UI.

| Field | Default | Description |
| --- | --- | --- |
| `modelQueueMaxWaitMs` | `3600000` (60 minutes) | Cumulative queue wait per logical model call, shared across repeated queue entries; excludes normal generation time |
| `responseHeaderTimeoutMs` | `60000` (1 minute) | Time limit for receiving model request HTTP response headers |
| `streamIdleTimeoutMs` | `300000` (5 minutes) | Time limit for receiving the next stream chunk; resets when data arrives |
| `preserveThinking` | `true` | Includes historical Qoder reasoning content in subsequent requests; does not control reasoning mode or effort, or delete chat history |

- Time values are positive integers in milliseconds; the queue wait limit must not exceed `2147483647`. `0` does not mean unlimited waiting.
- Use unquoted booleans `true` / `false` for `preserveThinking`.
- Remove a field to restore its default. Queue limits previously saved through the UI remain valid.
- Loaded changes apply to new calls; existing calls retain their configuration. Reload the profile or restart DSH if changes are not loaded automatically.
