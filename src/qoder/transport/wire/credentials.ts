/** Subscriber credential material shared across Qoder endpoint protocols. */
export interface QoderCredentials {
  userID: string
  authToken: string
  name: string
  email: string
  machineID?: string
  organizationId?: string
  organizationTags?: string[]
  dataPolicyAgreed?: boolean
}
