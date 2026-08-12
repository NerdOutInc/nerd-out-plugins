import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CoordinatedNodeOAuthClientProvider } from './coordinated-node-oauth-client-provider'
import { NodeOAuthClientProvider } from './node-oauth-client-provider'
import { acquireCredentialMutationLock, getConfigFilePath } from './mcp-auth-config'

const originalConfigDirectory = process.env.MCP_REMOTE_CONFIG_DIR
const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  if (originalConfigDirectory === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR
  else process.env.MCP_REMOTE_CONFIG_DIR = originalConfigDirectory
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
  )
})

async function fixture(scope?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-coordinated-provider-'))
  temporaryDirectories.push(root)
  process.env.MCP_REMOTE_CONFIG_DIR = root
  const serverUrlHash = 'scope-upgrade'
  const clientPath = getConfigFilePath(serverUrlHash, 'client_info.json')
  const tokenPath = getConfigFilePath(serverUrlHash, 'tokens.json')
  await fs.mkdir(path.dirname(clientPath), { recursive: true })
  await Promise.all([
    fs.writeFile(
      clientPath,
      JSON.stringify({
        client_id: 'cached-client',
        redirect_uris: ['http://127.0.0.1:45678/oauth/callback'],
        scope,
        token_endpoint_auth_method: 'none',
      }),
    ),
    fs.writeFile(
      tokenPath,
      JSON.stringify({ access_token: 'access', refresh_token: 'refresh', token_type: 'bearer' }),
    ),
  ])
  const provider = new CoordinatedNodeOAuthClientProvider({
    callbackPort: 45678,
    host: '127.0.0.1',
    requiredClientScope: 'notes:read notes:write',
    serverUrl: 'https://recall.example',
    serverUrlHash,
  })
  return { clientPath, provider, tokenPath }
}

describe('coordinated client scope upgrades', () => {
  it.each(['notes:read', undefined])('rotates an incompatible cached registration (%s)', async (scope) => {
    const { clientPath, provider, tokenPath } = await fixture(scope)
    await expect(provider.clientInformation()).resolves.toBeUndefined()
    await expect(fs.readFile(clientPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(tokenPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await provider.releaseCredentialLease()
  })

  it('accepts the same scopes in any order', async () => {
    const { clientPath, provider, tokenPath } = await fixture('notes:write notes:read')
    await expect(provider.clientInformation()).resolves.toMatchObject({ client_id: 'cached-client' })
    await expect(fs.readFile(clientPath)).resolves.toBeDefined()
    await expect(fs.readFile(tokenPath)).resolves.toBeDefined()
    await provider.releaseCredentialLease()
  })

  it.each([undefined, 'notes:read'])(
    'does not re-rotate the registration response during the code exchange (%s)',
    async (assignedScope) => {
      const { clientPath, provider, tokenPath } = await fixture('notes:read')
      await expect(provider.clientInformation()).resolves.toBeUndefined()
      await provider.saveClientInformation({
        client_id: 'replacement-client',
        redirect_uris: ['http://127.0.0.1:45678/oauth/callback'],
        ...(assignedScope ? { scope: assignedScope } : {}),
        token_endpoint_auth_method: 'none',
      })
      await expect(provider.clientInformation()).resolves.toMatchObject({
        client_id: 'replacement-client',
        scope: assignedScope ?? 'notes:read notes:write',
      })
      await expect(fs.readFile(clientPath)).resolves.toBeDefined()
      await expect(fs.readFile(tokenPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await provider.releaseCredentialLease()
    },
  )
})

describe('refresh rotation persistence', () => {
  const rotatedTokens = {
    access_token: 'rotated-access',
    refresh_token: 'rotated-refresh',
    token_type: 'bearer',
  }

  it('reports quiescence immediately when no credential mutation is under way', async () => {
    const { provider } = await fixture('notes:write notes:read')
    const start = Date.now()
    await provider.waitForCredentialMutationQuiescence()
    expect(Date.now() - start).toBeLessThan(1_000)
  })

  it('holds shutdown until an in-flight token replacement persists', async () => {
    const { provider, tokenPath } = await fixture('notes:write notes:read')
    await provider.clientInformation()
    let quiesced = false
    const wait = provider.waitForCredentialMutationQuiescence().then(() => {
      quiesced = true
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(quiesced).toBe(false)
    await provider.saveTokens(rotatedTokens)
    await wait
    expect(JSON.parse(await fs.readFile(tokenPath, 'utf8'))).toMatchObject({
      access_token: 'rotated-access',
      refresh_token: 'rotated-refresh',
    })
    // saveTokens released the cross-process lease; another owner can acquire.
    const lease = await acquireCredentialMutationLock('scope-upgrade', 1_000)
    await lease.release()
  })

  it('does not hold shutdown while parked awaiting user consent', async () => {
    const { provider } = await fixture('notes:write notes:read')
    provider.options.authorizationUrlHandler = async () => undefined
    await provider.clientInformation()
    await provider.redirectToAuthorization(new URL('https://recall.example/oauth/authorize'))
    const start = Date.now()
    await provider.waitForCredentialMutationQuiescence()
    expect(Date.now() - start).toBeLessThan(1_000)
    await provider.releaseCredentialLease()
  })

  it('gives up after the bounded timeout instead of hanging shutdown', async () => {
    const { provider } = await fixture('notes:write notes:read')
    await provider.clientInformation()
    const start = Date.now()
    await provider.waitForCredentialMutationQuiescence(150)
    const waited = Date.now() - start
    expect(waited).toBeGreaterThanOrEqual(100)
    expect(waited).toBeLessThan(5_000)
    await provider.releaseCredentialLease()
  })

  it('retries transient token-write failures before surrendering a rotation', async () => {
    const { provider, tokenPath } = await fixture('notes:write notes:read')
    await provider.clientInformation()
    const saveTokensSpy = vi
      .spyOn(NodeOAuthClientProvider.prototype, 'saveTokens')
      .mockRejectedValueOnce(new Error('transient write failure'))
      .mockRejectedValueOnce(new Error('transient write failure'))
    await provider.saveTokens(rotatedTokens)
    expect(saveTokensSpy).toHaveBeenCalledTimes(3)
    expect(JSON.parse(await fs.readFile(tokenPath, 'utf8'))).toMatchObject({
      access_token: 'rotated-access',
    })
  })
})
