import type { QoderLocalizedText } from '../qoder/account.ts'

export const zh = {
  accountConnectionTitle: 'Qoder 账号',
  signInDescription: '登录 Qoder，使用当前区域的订阅和模型。',
  manageAccount: '管理账号',
  manageCredential: '管理凭据',
  changeAccount: '更换账号',
  editPat: '编辑 PAT',
  patActive: '正在使用 PAT',
  saveAndUsePat: '保存并使用 PAT',
  useSavedPat: '使用已保存的 PAT',
  signInAgain: '重新登录',
  reopenLogin: '重新打开官网',
  loginLinkCopied: '链接已复制',
  loginTimeRemaining: '链接剩余有效时间：{seconds} 秒',
  regionChanged: '已切换服务区域；原区域如有未完成的登录，已取消。',
  regionChangeFailed: '服务区域切换失败，请重试。',
  browserRejected: 'Qoder 未完成授权，请重新登录。',
  browserStorageFailed: '官网授权已完成，但凭据保存失败。请检查存储后重新登录。',
  authorizationConnectionFailed: '暂时无法连接或读取登录状态，请稍后重试。',
  patSaveFailed: 'PAT 保存或启用失败，请重试。',
  browserRemoveFailed: '浏览器授权移除失败，请检查凭据存储是否可写后重试。',
  browserLoginTitle: 'Qoder 官网登录',
  browserMethod: '浏览器授权',
  savedBrowserAccount: '已保存的浏览器账号',
  patMethod: 'PAT 鉴权',
  signedOut: '未连接',
  sharedAuthorization: '当前区域的账号由所有连接此 DSH 实例的客户端共享。',
  signInQoder: '通过 Qoder 登录',
  signOutQoder: '移除浏览器授权',
  usePat: '使用 PAT',
  useBrowser: '使用已保存的浏览器授权',
  cancelLogin: '取消登录',
  openLogin: '打开登录页面',
  copyLogin: '复制登录链接',
  copyLoginFailed: '无法复制，请使用“打开登录页面”。',
  browserWaiting: '等待在 Qoder 官网完成验证与授权…',
  browserSaving: '正在保存授权…',
  browserComplete: '已登录。',
  browserCancelled: '登录已取消。',
  browserTimeout: '登录链接已过期，请重新发起登录。',
  browserFailed: '登录未完成，或授权保存失败。请检查账号状态后重试。',
  browserExpired: '浏览器授权已失效，请重新登录。',
  browserUnsaved: '续期凭据尚未保存，重启后可能需要重新登录；下次使用时将重试保存。',
  browserOperationFailed: '无法更新登录状态，请重试。',
  queueTitle: 'Qoder 模型排队',
  queueWaiting: '{model} 正在排队',
  queueRunningFor: '{model} 正在排队，用时 {duration} ···',
  queueHourUnit: '小时',
  queueMinuteUnit: '分',
  queueSecondUnit: '秒',
  queueCount: '排队数量：{count}',
  queueEstimate: '预计等待 {seconds} 秒',
  queueElapsed: '已等待 {seconds} 秒',
  queueUnavailable: 'Qoder 排队状态暂不可用',
  queueServiceUnavailable: '服务暂不可用，继续等待',
  queueBudget: '等待上限 {seconds} 秒',
  nav: 'Qoder',
  title: 'Qoder 凭据',
  configured: '已配置',
  missing: '未配置',
  loading: '正在读取凭据状态…',
  loadFailed: '无法读取凭据状态。',
  retry: '重试',
  edit: '编辑',
  cancel: '取消',
  regionLabel: '服务区域',
  regionGlobal: '国际版 (Global)',
  regionChina: '中国区 (CN)',
  regionHint: '请确保 PAT 与所选服务区域匹配。',
  tokenLabel: 'Personal Access Token (PAT)',
  tokenPlaceholder: '输入新的 Personal Access Token',
  configuredHint: '已配置——输入新值可替换',
  readOnly: '当前凭据存储不可写。',
  save: '保存',
  saving: '正在保存…',
  saved: 'Qoder 设置已保存。',
  saveFailed: 'Qoder 设置保存失败，请重试。',
  remove: '删除',
  removing: '正在删除…',
  removeFailed: '凭据删除失败，请重试。',
  confirmRemove: '删除已保存的 Qoder 凭据？删除后，新的模型请求将无法运行。',
  customized: '自定义设置',
  modelsTitle: '模型目录',
  modelsLoading: '正在读取模型设置…',
  modelsUnavailable: '当前无法读取或保存模型设置。',
  modelsEnabled: '已启用 {count} 个模型',
  modelsFetch: '获取可用模型',
  modelsFetching: '正在获取…',
  modelsFetchFailed: '无法获取可用模型。',
  modelsRequired: '至少需要保留一个模型。',
  modelUnavailable: '不可用',
  modelRate: '{value}x',
  modelRateFree: '免费',
  modelRateDiscount: '{value}x（原 {original}x）',
  modelRateUnknown: '倍率未知',
  contextTierLabel: '上下文',
  contextTierDefaultSuffix: '（默认）',
  contextTierHint: '选择该模型使用的上下文档位；更大的档位会同时提升 DSH 的上下文预算并改变 Qoder 请求使用的档位。',
  contextSelectFailed: '上下文切换失败，请重试。',
  contextSelectTitle: '选择上下文大小',
  contextSelectMenuHeader: '上下文容量',
  accountTitle: 'Qoder',
  accountLoading: '正在读取账号与额度…',
  accountFailed: '无法读取账号信息与额度。',
  accountCredentialHint: '请先在“模型”设置中登录 Qoder 或选择已配置的 PAT。',
  refresh: '刷新',
  refreshing: '正在刷新…',
  userQuotaTitle: '个人额度',
  orgResourceTitle: '组织资源包',
  addOnQuotaTitle: '增值额度',
  dedicatedResourceTitle: '专属资源包',
  dedicatedResourceExpiresAt: '有效期至：{value}',
  quotaRemaining: '剩余 {value}%',
  quotaUsed: '已用 {used} / {total} {unit}',
  resetsAt: '重置时间：{value}',
  noQuota: '暂无可用额度信息',
  quotaExceeded: '当前订阅额度已用尽。',
  plan: '套餐计划',
  planExpiresAt: '有效期至：{value}',
  organization: '组织：{name}',
  accountSuspended: '当前账号或组织已被暂停/冻结。',
  searchModeLabel: '联网搜索模式',
  searchModeAuto: '智能路由 (自动)',
  searchModeAlways: '始终使用 Qoder',
  searchModeDisabled: '禁用',
  searchModeHint: '智能路由模式下，使用 Qoder 模型时走 Qoder 搜索，使用其他模型时自动回退给备用搜索。',
}

export const en: typeof zh = {
  accountConnectionTitle: 'Qoder account',
  signInDescription: 'Sign in to use your subscription and models for this region.',
  manageAccount: 'Manage account',
  manageCredential: 'Manage credentials',
  changeAccount: 'Change account',
  editPat: 'Edit PAT',
  patActive: 'Using PAT',
  saveAndUsePat: 'Save and use PAT',
  useSavedPat: 'Use saved PAT',
  signInAgain: 'Sign in again',
  reopenLogin: 'Reopen Qoder website',
  loginLinkCopied: 'Link copied',
  loginTimeRemaining: 'Link expires in {seconds} seconds',
  regionChanged: 'Region changed; any unfinished sign-in for the previous region was cancelled.',
  regionChangeFailed: 'Could not change region. Please retry.',
  browserRejected: 'Qoder authorization was not completed. Sign in again.',
  browserStorageFailed: 'Website authorization completed, but credentials could not be saved. Check storage and sign in again.',
  authorizationConnectionFailed: 'Could not connect or read sign-in status. Please retry shortly.',
  patSaveFailed: 'Could not save or activate the PAT. Please retry.',
  browserRemoveFailed: 'Could not remove browser authorization. Check that credential storage is writable and retry.',
  browserLoginTitle: 'Qoder website sign-in',
  browserMethod: 'Browser authorization',
  savedBrowserAccount: 'Saved browser account',
  patMethod: 'PAT authentication',
  signedOut: 'Disconnected',
  sharedAuthorization: 'The account for this region is shared by all clients connected to this DSH instance.',
  signInQoder: 'Sign in with Qoder',
  signOutQoder: 'Remove browser authorization',
  usePat: 'Use PAT',
  useBrowser: 'Use saved browser authorization',
  cancelLogin: 'Cancel sign-in',
  openLogin: 'Open sign-in page',
  copyLogin: 'Copy sign-in link',
  copyLoginFailed: 'Could not copy. Use Open sign-in page.',
  browserWaiting: 'Complete verification and authorization on the Qoder website…',
  browserSaving: 'Saving authorization…',
  browserComplete: 'Signed in.',
  browserCancelled: 'Sign-in cancelled.',
  browserTimeout: 'Sign-in link expired. Start a new sign-in.',
  browserFailed: 'Sign-in or saving authorization failed. Check account status and retry.',
  browserExpired: 'Browser authorization expired. Sign in again.',
  browserUnsaved: 'Renewed credentials have not been saved. Restarting may require sign-in; saving will be retried on next use.',
  browserOperationFailed: 'Could not update sign-in status. Please retry.',
  queueTitle: 'Qoder model queue',
  queueWaiting: '{model} is queued',
  queueRunningFor: '{model} queued for {duration} ···',
  queueHourUnit: 'h',
  queueMinuteUnit: 'm',
  queueSecondUnit: 's',
  queueCount: 'Queue count: {count}',
  queueEstimate: 'Estimated wait: {seconds}s',
  queueElapsed: 'Waited {seconds}s',
  queueUnavailable: 'Qoder queue status is temporarily unavailable',
  queueServiceUnavailable: 'Service unavailable; waiting',
  queueBudget: 'Wait limit: {seconds}s',
  nav: 'Qoder',
  title: 'Qoder credential',
  configured: 'Configured',
  missing: 'Not configured',
  loading: 'Reading credential status…',
  loadFailed: 'Could not read credential status.',
  retry: 'Retry',
  edit: 'Edit',
  cancel: 'Cancel',
  regionLabel: 'Service Region',
  regionGlobal: 'Global',
  regionChina: 'China (CN)',
  regionHint: 'Ensure your PAT matches the selected service region.',
  tokenLabel: 'API Key',
  tokenPlaceholder: 'Enter a new Personal Access Token',
  configuredHint: 'Configured — enter a new value to replace',
  readOnly: 'The current credential store is read-only.',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Qoder settings saved.',
  saveFailed: 'Could not save the Qoder settings. Try again.',
  remove: 'Remove',
  removing: 'Removing…',
  removeFailed: 'Could not remove the credential. Try again.',
  confirmRemove: 'Remove the stored Qoder credential? New model requests will stop working.',
  customized: 'Custom settings',
  modelsTitle: 'Model catalog',
  modelsLoading: 'Reading model settings…',
  modelsUnavailable: 'Model settings cannot currently be read or saved.',
  modelsEnabled: '{count} models enabled',
  modelsFetch: 'Fetch available models',
  modelsFetching: 'Fetching…',
  modelsFetchFailed: 'Could not fetch available models.',
  modelsRequired: 'Keep at least one model.',
  modelUnavailable: 'Unavailable',
  modelRate: '{value}x',
  modelRateFree: 'Free',
  modelRateDiscount: '{value}x (was {original}x)',
  modelRateUnknown: 'Rate unknown',
  contextTierLabel: 'Context',
  contextTierDefaultSuffix: ' (default)',
  contextTierHint: 'Select the context tier for this model. A larger tier raises the DSH context budget and changes the tier the Qoder request uses.',
  contextSelectFailed: 'Could not change the context window. Please retry.',
  contextSelectTitle: 'Select context window size',
  contextSelectMenuHeader: 'Context Capacity',
  accountTitle: 'Qoder',
  accountLoading: 'Reading account and quota…',
  accountFailed: 'Could not read account details or quota.',
  accountCredentialHint: 'Sign in to Qoder or select a configured PAT in Models settings first.',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  userQuotaTitle: 'Personal Quota',
  orgResourceTitle: 'Org Resource Package',
  addOnQuotaTitle: 'Add-on Credits',
  dedicatedResourceTitle: 'Dedicated Resource Package',
  dedicatedResourceExpiresAt: 'Expires at: {value}',
  quotaRemaining: '{value}% remaining',
  quotaUsed: 'Used {used} / {total} {unit}',
  resetsAt: 'Resets: {value}',
  noQuota: 'No quota metrics available',
  quotaExceeded: 'The current subscription quota is exhausted.',
  plan: 'Plan',
  planExpiresAt: 'Expires at: {value}',
  organization: 'Org: {name}',
  accountSuspended: 'Account or organization is currently suspended.',
  searchModeLabel: 'Web Search Mode',
  searchModeAuto: 'Smart Routing (Auto)',
  searchModeAlways: 'Always use Qoder',
  searchModeDisabled: 'Disabled',
  searchModeHint: 'In auto mode, searches route to Qoder when using Qoder models, and fall back to ambient providers otherwise.',
}


export type QoderCredentialCopy = keyof typeof zh

/**
 * Compare one provider language tag against the requested locale.
 *
 * `prefix` additionally accepts a shared primary subtag, which is what lets the
 * built-in `zh`/`en` ids reach the provider's `zh-CN`/`en-US` keys.
 */
function localeMatches(tag: string, requested: string, prefix: boolean): boolean {
  const normalized = tag.trim().toLowerCase()
  if (normalized === requested) return true
  if (!prefix) return false
  const primary = requested.split('-')[0]
  return primary.length > 0 && normalized.split('-')[0] === primary
}

/**
 * Return the first provider translation whose language tag matches the request.
 *
 * `prefix` decides whether a shared primary subtag counts as a match; blank
 * translations are skipped so they cannot shadow a later usable one.
 */
function pickLocalizedValue(
  values: Readonly<Record<string, string>>,
  requested: string,
  prefix: boolean,
): string | undefined {
  for (const [tag, value] of Object.entries(values)) {
    if (!localeMatches(tag, requested, prefix)) continue
    const text = typeof value === 'string' ? value.trim() : ''
    if (text.length > 0) return text
  }
  return undefined
}

/**
 * Resolve provider copy for the active UI locale.
 *
 * Order: exact language tag, then a shared primary subtag, then the provider's
 * language-neutral fallback, then any translation at all. The client owns this
 * choice because only it knows the locale the user is reading.
 */
export function resolveLocalizedText(
  text: QoderLocalizedText | undefined,
  locale: string,
): string | undefined {
  if (!text) return undefined
  const values = text.values ?? {}
  const requested = typeof locale === 'string' ? locale.trim().toLowerCase() : ''
  if (requested.length > 0) {
    const exact = pickLocalizedValue(values, requested, false)
    if (exact !== undefined) return exact
    const related = pickLocalizedValue(values, requested, true)
    if (related !== undefined) return related
  }
  const fallback = typeof text.fallback === 'string' ? text.fallback.trim() : ''
  if (fallback.length > 0) return fallback
  for (const value of Object.values(values)) {
    const candidate = typeof value === 'string' ? value.trim() : ''
    if (candidate.length > 0) return candidate
  }
  return undefined
}
