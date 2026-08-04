import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireCredentialMutationLock,
  getConfigDir,
  getConfigFilePath,
  writeJsonFile,
  writeTextFile,
} from './mcp-auth-config'

const temporaryDirectories: string[] = []
const previousConfigDirectory = process.env.MCP_REMOTE_CONFIG_DIR

afterEach(async () => {
  if (previousConfigDirectory === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR
  else process.env.MCP_REMOTE_CONFIG_DIR = previousConfigDirectory
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })))
})

async function useTemporaryCache(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-oauth-cache-'))
  temporaryDirectories.push(directory)
  process.env.MCP_REMOTE_CONFIG_DIR = directory
  return directory
}

describe('credential cache mutation ownership', () => {
  it('serializes two owners of the same cache', async () => {
    await useTemporaryCache()
    const first = await acquireCredentialMutationLock('server-hash', 1_000)
    let secondAcquired = false
    const secondPromise = acquireCredentialMutationLock('server-hash', 1_000).then((lease) => {
      secondAcquired = true
      return lease
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(secondAcquired).toBe(false)
    await first.release()
    const second = await secondPromise
    expect(secondAcquired).toBe(true)
    await second.release()
  })

  it('atomically replaces mode-0600 JSON and text without stale temp files', async () => {
    await useTemporaryCache()
    await writeJsonFile('server-hash', 'tokens.json', { access_token: 'first' })
    await writeJsonFile('server-hash', 'tokens.json', { access_token: 'second' })
    await writeTextFile('server-hash', 'code_verifier.txt', 'verifier')

    const tokensPath = getConfigFilePath('server-hash', 'tokens.json')
    const verifierPath = getConfigFilePath('server-hash', 'code_verifier.txt')
    expect(JSON.parse(await fs.readFile(tokensPath, 'utf8'))).toEqual({ access_token: 'second' })
    expect(await fs.readFile(verifierPath, 'utf8')).toBe('verifier')
    expect((await fs.stat(tokensPath)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(verifierPath)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(getConfigDir())).mode & 0o777).toBe(0o700)
    expect((await fs.readdir(getConfigDir())).some((name) => name.endsWith('.tmp'))).toBe(false)
  })
})
