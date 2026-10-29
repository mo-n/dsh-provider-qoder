<div align="center">

  <img src="./assets/icon-full.png" alt="dsh-provider-qoder" width="650" />

  <h1>dsh-provider-qoder</h1>

[![npm version](https://img.shields.io/npm/v/dsh-provider-qoder.svg?color=blue)](https://www.npmjs.com/package/dsh-provider-qoder)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-6f42c1.svg)](https://github.com/mo-n/dsh-provider-qoder)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English | [简体中文](./README_CN.md)

Use your Qoder subscription in DeepSeek Harness (DSH).

</div>

## Features

- Sign in through your browser or authenticate with a Personal Access Token (PAT).
- Switch between Global and China service regions.
- Support for Qoder model queues with visible waiting progress.
- Integrated Qoder web search.
- Multimodal input, image generation, and image search.
- Switch between the model's available context tiers during a conversation.

Daily check-ins and multi-account management are not supported.

## Installation

### Prerequisites

- An active Qoder subscription matching the selected service region.
- Requirements: DSH `>=0.1.7-rc.2`.

### Install from npm

Run in your terminal:

```sh
dsh plugin --profile web add dsh-provider-qoder
```

## Configuration & Usage

### 1. Select a Service Region and Sign In

In DSH Web, open **Settings → Models → Qoder account** and select your service region.

Click **Sign in with Qoder** and complete authorization on the website. Return to DSH to select a model available to your account.

Alternatively, choose **Use PAT**, enter a token and click **Save and use PAT**, or use a saved PAT. **Manage account** or **Manage credentials** lets you change accounts, switch authentication methods or remove authorization.

### 2. View Account & Manage Models

Open **Settings → Qoder** to view account and quota details, configure web search, and adjust enabled models.

<p align="center">
  <img src="./assets/account-quota.png" alt="Qoder account quota and model settings" width="650" />
</p>

### 3. Advanced Settings

For advanced YAML options (queue wait limits, request timeouts, and retaining reasoning content from previous messages), see [Configuration](./docs/wiki/configuration.md).

## References

- [pi-provider-qoder](https://github.com/simonsmh/pi-provider-qoder) - Reference implementation for Qoder authentication, API communication, and protocol handling.

## Feedback

Please report issues via [GitHub Issues](https://github.com/mo-n/dsh-provider-qoder/issues) with the plugin and DSH versions, selected service region, reproduction steps, and sanitized error messages. Do not submit PATs, short-lived tokens, or personal account information.

## Disclaimer

This is a community adapter plugin and is not affiliated with Qoder or DeepSeek.

Using this project may result in account or feature restrictions, account bans, or service suspension or termination. Successful requests and normal billing do not imply official authorization or eliminate account risks.

Use of Qoder services is subject to the applicable terms of service, subscription limits, and account policies. This project's MIT License applies only to the project code and grants no rights to use Qoder services.

## License

This project is licensed under the [MIT License](LICENSE).
