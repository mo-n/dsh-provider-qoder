import test from 'node:test'
import assert from 'node:assert/strict'
import { QoderAuthService } from '../src/qoder/transport/auth.ts'
import { QoderUsageReader } from '../src/qoder/transport/account-reader.ts'

/**
 * A Free plan reports an all-zero subscription quota and carries its whole
 * balance in the add-on pool. The reader must surface that pool, otherwise the
 * account card has no bucket to render and claims the account has no quota.
 */
for (const field of ['addOnQuota', 'add_on_quota'] as const) {
  test(`QoderUsageReader reads a Free plan add-on quota from ${field}`, async () => {
    const usagePayload = {
      userId: 'user-free',
      userType: 'personal_standard',
      usageType: 'credits',
      totalUsagePercentage: 0.27,
      isQuotaExceeded: false,
      expiresAt: 253402214400000,
      upgradeUrl: 'https://qoder.com/pricing?client=qoder',
      userQuota: {
        total: 0,
        used: 0,
        remaining: 0,
        percentage: 0,
        unit: 'credits',
      },
      [field]: {
        total: 2600,
        used: 688,
        remaining: 1912,
        percentage: 0.27,
        unit: 'credits',
        detailUrl: 'https://qoder.com/account/usage',
      },
      isPlanQuotaProrated: false,
    }
    const fetchMock = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        return new Response(JSON.stringify({ token: 'jt-addon-test', expires_in: 3_600_000 }))
      }
      if (url.includes('/userinfo')) {
        return new Response(JSON.stringify({ id: 'user-free', email: 'free@qoder.sh', name: 'Free Dev' }))
      }
      if (url.includes('/quota/usage')) {
        return new Response(JSON.stringify(usagePayload))
      }
      throw new Error(`unexpected URL: ${url}`)
    }

    const authService = new QoderAuthService({
      fetch: fetchMock as typeof fetch,
      resolveMachineId: () => 'machine-test',
    })
    const reader = new QoderUsageReader({ authService, fetch: fetchMock as typeof fetch })

    const account = await reader.readAccount('pt-addon-test')

    // The subscription quota stays zero — that is what the plan actually reports.
    assert.equal(account.usage?.userQuota?.total, 0)
    // ...but the add-on pool carries the balance, so it must survive the seam.
    assert.equal(account.usage?.addOnQuota?.total, 2600)
    assert.equal(account.usage?.addOnQuota?.used, 688)
    assert.equal(account.usage?.addOnQuota?.remaining, 1912)
    assert.equal(account.usage?.addOnQuota?.unit, 'credits')

    // qoder-cli applies the same fraction-to-percentage conversion to add-on credits.
    assert.equal(account.usage?.addOnQuota?.percentage, 27)
  })
}

test('QoderUsageReader omits the add-on quota pool when the provider sends none', async () => {
  let payload: Record<string, unknown> = {
    userQuota: { total: 3000, used: 84, remaining: 2916, percentage: 0.03, unit: 'credits' },
  }
  const fetchMock = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-no-addon', expires_in: 3_600_000 }))
    }
    if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-no-addon' }))
    if (url.includes('/quota/usage')) return new Response(JSON.stringify(payload))
    throw new Error(`unexpected URL: ${url}`)
  }
  const authService = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
  })
  const reader = new QoderUsageReader({ authService, fetch: fetchMock as typeof fetch })

  const absent = await reader.readAccount('pt-no-addon')
  assert.equal(absent.usage?.addOnQuota, undefined)
  assert.equal(absent.usage?.userQuota?.total, 3000)

  payload = {
    userQuota: { total: 3000, used: 84, remaining: 2916, percentage: 0.03, unit: 'credits' },
    addOnQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' },
  }
  const empty = await reader.readAccount('pt-no-addon', { force: true })
  assert.equal(empty.usage?.addOnQuota?.total, 0)
  assert.equal(empty.usage?.userQuota?.total, 3000)
})


test('QoderUsageReader prefers the snake-case add-on quota and falls back when null', async () => {
  const camelQuota = { total: 100, used: 20, remaining: 80, unit: 'credits' }
  const snakeQuota = { total: 200, used: 50, remaining: 150, unit: 'credits' }
  let payload: Record<string, unknown> = { addOnQuota: camelQuota, add_on_quota: snakeQuota }
  const fetchMock = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-alias', expires_in: 3_600_000 }))
    if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-alias' }))
    if (url.includes('/quota/usage')) return new Response(JSON.stringify(payload))
    throw new Error(`unexpected URL: ${url}`)
  }
  const authService = new QoderAuthService({ fetch: fetchMock as typeof fetch, resolveMachineId: () => 'machine-test' })
  const reader = new QoderUsageReader({ authService, fetch: fetchMock as typeof fetch })
  const preferred = await reader.readAccount('pt-alias')
  assert.equal(preferred.usage?.addOnQuota?.remaining, 150)

  payload = { addOnQuota: camelQuota, add_on_quota: null }
  const fallback = await reader.readAccount('pt-alias', { force: true })
  assert.equal(fallback.usage?.addOnQuota?.remaining, 80)
})
