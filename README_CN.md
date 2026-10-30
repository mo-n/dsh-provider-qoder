<div align="center">

  <img src="./assets/icon-full.png" alt="dsh-provider-qoder" width="160" />

  <h1>dsh-provider-qoder</h1>

[![npm version](https://img.shields.io/npm/v/dsh-provider-qoder.svg?color=blue)](https://www.npmjs.com/package/dsh-provider-qoder)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-6f42c1.svg)](https://github.com/mo-n/dsh-provider-qoder)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](./README.md) | 简体中文

在 DeepSeek Harness（DSH）中使用您的 Qoder 订阅。

</div>

## 功能

- 支持浏览器登录与个人访问令牌（PAT）授权。
- 支持国际版和中国区服务切换。
- 支持 Qoder 模型排队与进度显示。
- 集成 Qoder 联网搜索服务。
- 支持多模态输入、图片生成与图片搜索。
- 支持在对话中切换模型提供的上下文档位。

> [!NOTE]
> 本项目不支持签到与多账号管理。

## 安装

### 使用前提

- 拥有与所选服务区域匹配的可用 Qoder 订阅。
- 环境要求：DSH `>=0.2.0-rc.2`。

### 从 npm 安装

在终端执行：

```sh
dsh plugin --profile web add dsh-provider-qoder
```

## 配置与使用

### 1. 选择服务区域并登录

打开 DSH Web 的 **设置 → 模型 → Qoder 账号**，选择对应服务区域（国际版或中国区）。

支持两种授权方式：

- **网页授权（推荐）**：点击 **通过 Qoder 登录**，在官网完成授权。返回 DSH 后即可选择账号支持的模型。
- **PAT 令牌**：选择 **使用 PAT**，填写令牌后点击 **保存并使用 PAT**，或直接使用已保存的 PAT。

后续可通过 **管理账号** 或 **管理凭据** 更换账号、切换鉴权方式或移除授权。

### 2. 查看账号与设置模型

打开 **设置 → Qoder** 查看账号额度与重置时间，并可切换联网搜索策略与调整启用的模型。

<p align="center">
  <img src="./assets/account-quota_CN.png" alt="Qoder 账号额度与模型设置" width="650" />
</p>

### 3. 更多设置

插件支持通过 profile 的 YAML 配置文件（`cordis.patch.yml`）进行高级参数定制，包括：

- **模型传输渠道**（`modelTransport`）：支持 COSY 默认渠道或 Bearer model-server HTTP 渠道。
- **请求体压缩**（`requestCompression`）：支持启用 Zstd 请求体压缩以节省带宽。
- **排队与超时限制**（`modelQueueMaxWaitMs` / `streamIdleTimeoutMs` 等）：自定义单次调用累计排队等待上限及响应超时。
- **历史推理内容保留**（`preserveThinking`）：多轮对话中保留并携带历史 Qoder 推理内容。

完整配置字段、默认值与环境变量说明见 [配置说明](./docs/wiki/configuration_CN.md)。

## 参考项目

- [pi-provider-qoder](https://github.com/simonsmh/pi-provider-qoder) - Qoder 认证、API 通信及协议处理的参考实现。

## 反馈

请通过 [GitHub Issues](https://github.com/mo-n/dsh-provider-qoder/issues) 提交问题，附上插件和 DSH 版本、所选服务区域、复现步骤及脱敏后的错误信息。**请勿提交 PAT、短期令牌或个人账号信息。**

## 声明

> [!WARNING]
> - 本项目是社区适配插件，与 Qoder、DeepSeek 官方均无关联。
> - 使用本项目可能导致账号或功能受限、账号封禁、服务暂停或终止。能够正常调用、正常扣费，不代表获得官方授权或不存在账号风险。
> - 使用 Qoder 服务须遵守其适用的服务条款、订阅限制及账号政策。本项目的 MIT 许可证仅适用于项目代码，不授予任何 Qoder 服务使用权。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
