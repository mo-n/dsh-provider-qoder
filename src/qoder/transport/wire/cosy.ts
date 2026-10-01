/**
 * COSY authentication headers and signature algorithm for Qoder services.
 *
 * Implements RSA + AES + MD5 signature generation required by the upstream
 * Qoder gateway.
 *
 * @module dsh-provider-qoder/qoder/transport/wire/cosy
 */

import crypto from 'node:crypto'
import { hostname } from 'node:os'
import { getMachineId } from '../machine-id.ts'

const qoderRSAPublicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

// Declared upstream client version; offline protocol fixtures retain their audited version.
export const qoderIdeVersion = '1.1.65'
export const qoderClientType = '5'
export const defaultUserAgent = `qoder/${qoderIdeVersion}`
const qoderDataPolicy = 'disagree'
const qoderLoginVersion = 'v2'
const qoderMachineTypeMagic = '5'

export function qoderMachineOs(platform: string = process.platform, arch: string = process.arch): string {
  const architecture = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch
  return `${architecture}_${platform}`
}

export interface CosyCredentials {
  userID: string
  authToken: string
  name: string
  email: string
  machineID?: string
  organizationId?: string
  organizationTags?: string[]
  dataPolicyAgreed?: boolean
}

interface UserInfo {
  uid: string
  security_oauth_token: string
  organization_id?: string
  organization_tags?: string[]
  data_policy_agreed?: boolean
}

interface CosyPayload {
  version: string
  requestId: string
  info: string
  cosyVersion: string
  ideVersion: string
}

export function computeSigPath(urlStr: string): string {
  const parsed = new URL(urlStr)
  let sigPath = parsed.pathname
  if (sigPath.startsWith('/algo')) {
    sigPath = sigPath.substring('/algo'.length)
  }
  return sigPath
}

function rsaEncryptBase64(data: Buffer | string): string {
  const key = {
    key: qoderRSAPublicKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  }
  const encrypted = crypto.publicEncrypt(key, typeof data === 'string' ? Buffer.from(data) : data)
  return encrypted.toString('base64')
}

function aesEncryptCBCBase64(plaintext: string, keyStr: string): string {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(keyStr), Buffer.from(keyStr))
  let encrypted = cipher.update(plaintext, 'utf8', 'base64')
  encrypted += cipher.final('base64')
  return encrypted
}

export function buildAuthHeaders(
  body: Buffer | string | null,
  requestURL: string,
  creds: CosyCredentials,
): Record<string, string> {
  if (!creds.userID) {
    throw new Error('cosy: user id is empty')
  }
  if (!creds.authToken) {
    throw new Error('cosy: auth token is empty')
  }

  const aesKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const userInfo: UserInfo = {
    uid: creds.userID,
    security_oauth_token: creds.authToken,
    ...creds.organizationId === undefined ? {} : { organization_id: creds.organizationId },
    ...creds.organizationTags === undefined ? {} : { organization_tags: creds.organizationTags },
    ...creds.dataPolicyAgreed === undefined ? {} : { data_policy_agreed: creds.dataPolicyAgreed },
  }

  const infoB64 = aesEncryptCBCBase64(JSON.stringify(userInfo), aesKey)
  const cosyKey = rsaEncryptBase64(aesKey)

  const timestamp = Math.floor(Date.now() / 1000).toString()
  const requestId = crypto.randomUUID()

  const cosyPayload: CosyPayload = {
    version: 'v1',
    requestId,
    info: infoB64,
    cosyVersion: qoderIdeVersion,
    ideVersion: '',
  }

  const payloadB64 = Buffer.from(JSON.stringify(cosyPayload)).toString('base64')
  const sigPath = computeSigPath(requestURL)

  const bodyStr = body ? (Buffer.isBuffer(body) ? body.toString('utf8') : body) : ''
  const sigInput = `${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyStr}\n${sigPath}`
  const sig = crypto.createHash('md5').update(sigInput).digest('hex')

  const machineID = creds.machineID || getMachineId()

  const isModelRequest = sigPath === '/api/v2/service/pro/sse/agent_chat_generation'
  const machineHostname = hostname().replace(/[^\x20-\x7e]/gu, '').trim()

  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': creds.userID,
    'Cosy-Date': timestamp,
    'Cosy-Version': qoderIdeVersion,
    'Cosy-Machineid': machineID,
    'Cosy-Machinetoken': machineID,
    'Cosy-Machinetype': qoderMachineTypeMagic,
    'Cosy-Machineos': qoderMachineOs(),
    ...isModelRequest && machineHostname ? { 'Cosy-MachineHostname': machineHostname } : {},
    'Cosy-Clienttype': qoderClientType,
    'Cosy-Business-Product': 'cli',
    'Cosy-Business-Type': 'agent',
    'Cosy-Scene': 'assistant',
    ...isModelRequest ? {} : { 'Cosy-Clientip': machineID },
    'Cosy-Data-Policy': creds.dataPolicyAgreed === true ? 'agree' : qoderDataPolicy,
    ...creds.organizationId ? { 'Cosy-Organization-Id': creds.organizationId } : {},
    ...creds.organizationTags?.length ? { 'Cosy-Organization-Tags': creds.organizationTags.join(',') } : {},
    'Login-Version': qoderLoginVersion,
  }
}
