import { describe, expect, it, mock } from 'bun:test'
mock.module('@/server/services/vault', () => ({
  createSecret: mock(async () => null),
  getSecretByKey: mock(async () => null),
  getSecretValue: mock(async () => null),
  updateSecretValueByKey: mock(async () => null),
  deleteSecret: mock(async () => false),
}))
const { getVaultOAuthToken } = await import('./_oauth-vault-access')
import { PROVIDER_ID_KEY, PROVIDER_TYPE_KEY } from './_oauth-token-store'

describe('getVaultOAuthToken (generic vault accessor)', () => {
  it('returns null when the config carries no provider identity (CLI/file mode)', async () => {
    // No reserved __providerId/__providerType → not a vault-backed sign-in;
    // the caller falls back to its own path (e.g. a CLI credentials file).
    await expect(getVaultOAuthToken({})).resolves.toBeNull()
    await expect(getVaultOAuthToken({ authFilePath: '~/.claude/.credentials.json' })).resolves.toBeNull()
  })

  it('returns null when no token bundle is stored for the provider', async () => {
    // Identity present but nothing in the vault for it → still falls back.
    const config = {
      [PROVIDER_ID_KEY]: 'no-such-provider-id',
      [PROVIDER_TYPE_KEY]: 'anthropic-oauth',
    }
    await expect(getVaultOAuthToken(config)).resolves.toBeNull()
  })
})
