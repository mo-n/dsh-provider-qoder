# dsh-provider-qoder

[![npm version](https://img.shields.io/npm/v/dsh-provider-qoder.svg?color=blue)](https://www.npmjs.com/package/dsh-provider-qoder)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-6f42c1.svg)](https://github.com/mo-n/dsh-provider-qoder)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)


[English](./README.md) | 简体中文

在 DeepSeek Harness（DSH） 中使用 Qoder 订阅，支持多模态、联网搜索和工具调用，可选择国际版或中国区 Qoder 服务。

插件负责认证和模型通信，工具执行、工作区操作及权限管理由 DSH 负责。
本项目是社区适配插件，与 Qoder、DeepSeek 官方均无关联。

## 功能

- 通过 Qoder Personal Access Token（PAT，个人访问令牌）配置订阅访问。
- 支持国际版（`global`）和中国区（`china`）服务。
- 获取账号可用模型，选择启用的模型，并在服务返回相关信息时显示价格倍率和推理强度选项。
- 支持多模态、搜索以及工具调用。
- 在设置中查看账号信息、额度和重置时间。

## 安装

### 使用前提

你需要可运行的 DSH Web 环境、可用的 Qoder 订阅，以及与所选服务区域匹配的 PAT。运行插件的 DSH profile 必须提供托管凭据服务；通过设置页面配置时，凭据存储还需可写。

本包的依赖范围为 DSH 相关包 `>=0.1.2-rc.1 <0.2`、Cordis `>=4.0.2 <5` 和 React `^18.2.0`。设置界面还依赖宿主提供凭据远程接口和设置插槽，请使用具备这些接口的 DSH 版本；上述范围不代表每个版本都经过实测。

### 从 npm 安装

在终端执行：

```sh
dsh plugin --profile web add dsh-provider-qoder
```

## 配置与使用

### 1. 保存服务区域和 PAT

打开 DSH Web 的 **设置 → 模型**，找到页面底部的 **Qoder 凭据** 卡片，点击 **编辑**。

| 服务区域 | 对应账号 |
| --- | --- |
| 国际版（Global，默认） | `qoder.com` |
| 中国区（CN） | `qoder.com.cn` |

选择与账号一致的区域，将 Qoder PAT 填入界面标为 **API 密钥** 的输入框，然后点击 **保存**。

### 2. 获取并选择模型

1. 保存 PAT 和服务区域后，再次点击 **编辑**。
2. 展开 **自定义设置**，点击 **获取可用模型**。
3. 选择需要启用的模型，至少保留一个，然后点击 **保存**。
4. 在 DSH 的模型选择器中选择 Qoder 模型，开始对话。

获取模型使用的是**已保存的 PAT 和服务区域**。更换账号或区域后，需要重新获取模型。初始模型目录仅供候选参考，实际可用模型以账号查询结果为准。模型倍率、推理强度选项及图片输入能力由 Qoder 提供，并非所有模型都有这些信息。

展开模型选择器时会自动刷新已启用 Qoder 模型的元数据，成功获取后缓存 5 分钟。设置可写时，更新后的倍率和能力信息也会同步到**自定义设置**显示的已保存目录，不会自动启用其他模型。刷新失败时保留最近一次成功获取的信息。

<p align="center">
  <img src="./assets/credentials-settings.png" alt="Qoder 凭据与模型配置" width="680" />
</p>

### 3. 查看账号与额度

打开 **设置 → Qoder** 查看账号额度，并可按需切换联网搜索策略：

<p align="center">
  <img src="./assets/account-quota.png" alt="Qoder 账号额度与搜索设置" width="650" />
</p>


## 后续计划功能
- [ ] 支持上下文窗口（Context Window）档位切换
- [ ] 请求限流排队机制
- [ ] 接入 Qoder 的 Protobuf 协议

## 参考项目

- [pi-provider-qoder](https://github.com/simonsmh/pi-provider-qoder) - Qoder 认证、API 通信及协议处理的参考实现。

## 反馈

请通过 [GitHub Issues](https://github.com/mo-n/dsh-provider-qoder/issues) 提交问题，附上插件和 DSH 版本、所选服务区域、复现步骤及脱敏后的错误信息。不要提交 PAT、短期令牌或个人账号信息。

本项目采用 MIT 许可证。
