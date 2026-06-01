import type { ContactsProvider } from '@/server/contacts/types'

const registry = new Map<string, ContactsProvider>()

export function registerContactsProvider(provider: ContactsProvider): void {
  if (registry.has(provider.type)) {
    throw new Error(`Contacts provider already registered: ${provider.type}`)
  }
  registry.set(provider.type, provider)
}

export function unregisterContactsProvider(type: string): void {
  registry.delete(type)
}

export function getContactsProvider(type: string): ContactsProvider | undefined {
  return registry.get(type)
}

export function listContactsProviders(): ContactsProvider[] {
  return [...registry.values()]
}
