import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CoordinatedNodeOAuthClientProvider } from './coordinated-node-oauth-client-provider'
import { getConfigFilePath } from './mcp-auth-config'

const originalConfigDirectory = process.env.MCP_REMOTE_CONFIG_DIR
const temporaryDirectories: string[] = []

afterEach(async () => {
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
