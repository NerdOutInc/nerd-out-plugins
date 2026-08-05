import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  acquireCredentialMutationLock,
  type CredentialMutationLease,
} from './mcp-auth-config'
import { NodeOAuthClientProvider } from './node-oauth-client-provider'
import type { OAuthProviderOptions } from './types'

/**
 * Holds one cross-process lease from OAuth client lookup through registration,
 * refresh/authorization, atomic token replacement, and verifier cleanup.
 */
export class CoordinatedNodeOAuthClientProvider extends NodeOAuthClientProvider {
  private credentialLease?: CredentialMutationLease
  private credentialLeasePromise?: Promise<CredentialMutationLease>
  private scopeCompatibilityChecked = false

  constructor(
    options: OAuthProviderOptions,
    initialCredentialLease?: CredentialMutationLease,
  ) {
    super(options)
    this.credentialLease = initialCredentialLease
  }

  async acquireCredentialLease(timeoutMs?: number): Promise<void> {
    if (this.credentialLease) return
    this.credentialLeasePromise ??= acquireCredentialMutationLock(
      this.options.serverUrlHash,
      timeoutMs,
    )
    this.credentialLease = await this.credentialLeasePromise
  }

  override async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    await this.acquireCredentialLease()
    const client = await super.clientInformation()
    const requiredScope = this.options.requiredClientScope
    if (!this.scopeCompatibilityChecked && client && requiredScope && !sameScopeSet(client.scope, requiredScope)) {
      this.scopeCompatibilityChecked = true
      await super.invalidateCredentials('all')
      return undefined
    }
    this.scopeCompatibilityChecked = true
    return client
  }

  override async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
    const requiredScope = this.options.requiredClientScope
    await super.saveClientInformation(
      requiredScope && !clientInformation.scope ? { ...clientInformation, scope: requiredScope } : clientInformation,
    )
  }

  override async saveTokens(tokens: OAuthTokens): Promise<void> {
    try {
      await super.saveTokens(tokens)
      await super.invalidateCredentials('verifier')
    } finally {
      await this.releaseCredentialLease()
    }
  }

  async releaseCredentialLease(): Promise<void> {
    const lease = this.credentialLease
    this.credentialLease = undefined
    this.credentialLeasePromise = undefined
    await lease?.release()
  }
}

export function sameScopeSet(left: string | undefined, right: string): boolean {
  const leftScopes = new Set(left?.split(/\s+/).filter(Boolean) ?? [])
  const rightScopes = new Set(right.split(/\s+/).filter(Boolean))
  return leftScopes.size === rightScopes.size && [...leftScopes].every((scope) => rightScopes.has(scope))
}
