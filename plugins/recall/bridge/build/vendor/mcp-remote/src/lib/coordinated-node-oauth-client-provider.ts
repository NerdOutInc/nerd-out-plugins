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
  private credentialMutationActive = false

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

  /**
   * Resolves once no registration/exchange/refresh can be mid-flight, or after
   * timeoutMs. Shutdown paths call this BEFORE tearing anything down: exiting
   * while the authorization server has already rotated the refresh token but
   * the response has not been persisted strands a rotated-out token on disk,
   * and presenting that token later trips OAuth reuse detection and revokes
   * the entire grant. The window opens when the SDK's auth flow enters
   * clientInformation() under the lease and closes when saveTokens() persists
   * (or the flow parks in redirectToAuthorization awaiting user consent,
   * where no token-endpoint call can be in flight).
   */
  async waitForCredentialMutationQuiescence(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.credentialLease && this.credentialMutationActive) {
      if (Date.now() >= deadline) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  override async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    await this.acquireCredentialLease()
    this.credentialMutationActive = true
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

  override async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Parked awaiting user consent: no token-endpoint call is in flight, so
    // shutdown must not wait on the (still held) lease.
    this.credentialMutationActive = false
    await super.redirectToAuthorization(authorizationUrl)
  }

  override async saveTokens(tokens: OAuthTokens): Promise<void> {
    try {
      // By the time saveTokens runs the server may already have rotated the
      // refresh token, so losing this write to a transient filesystem error
      // eventually revokes the grant (reuse detection). Retry briefly before
      // giving up.
      let lastError: unknown
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
        try {
          await super.saveTokens(tokens)
          lastError = undefined
          break
        } catch (error) {
          lastError = error
        }
      }
      if (lastError !== undefined) throw lastError
      await super.invalidateCredentials('verifier')
    } finally {
      await this.releaseCredentialLease()
    }
  }

  async releaseCredentialLease(): Promise<void> {
    this.credentialMutationActive = false
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
