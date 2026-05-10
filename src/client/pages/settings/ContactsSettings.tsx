import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/client/components/ui/button'
import { Plus, Users, Search } from 'lucide-react'
import { Input } from '@/client/components/ui/input'
import { EmptyState } from '@/client/components/common/EmptyState'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { SettingsListSkeleton } from '@/client/components/common/SettingsListSkeleton'
import { api, toastError } from '@/client/lib/api'
import { useKinList } from '@/client/hooks/useKinList'
import { useSSE } from '@/client/hooks/useSSE'
import { ContactCard, type ContactData, type KinInfo } from '@/client/components/contacts/ContactCard'
import { ContactFormDialog } from '@/client/components/contacts/ContactFormDialog'

export function ContactsSettings() {
  const { t } = useTranslation()
  const [contacts, setContacts] = useState<ContactData[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const { kins: kinList } = useKinList()
  const kinInfo = new Map<string, KinInfo>(kinList.map((k) => [k.id, { name: k.name, avatarUrl: k.avatarUrl }]))
  const [modalOpen, setModalOpen] = useState(false)
  const [editingContact, setEditingContact] = useState<ContactData | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const filteredContacts = contacts.filter((contact) => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase()
    if (contact.displayName.toLowerCase().includes(q)) return true
    if (contact.firstName?.toLowerCase().includes(q)) return true
    if (contact.lastName?.toLowerCase().includes(q)) return true
    if (contact.nicknames?.some((n) => n.nickname.toLowerCase().includes(q))) return true
    if (contact.identifiers?.some((id) => id.value.toLowerCase().includes(q) || id.label.toLowerCase().includes(q))) return true
    if (contact.platformIds?.some((p) => p.platform.toLowerCase().includes(q) || p.platformId.toLowerCase().includes(q))) return true
    if (contact.notes?.some((n) => n.content.toLowerCase().includes(q))) return true
    return false
  })

  const fetchContacts = useCallback(async () => {
    try {
      const data = await api.get<{ contacts: ContactData[] }>('/contacts')
      setContacts(data.contacts)
    } catch (err) {
      toast.error(t('contacts.fetchError', 'Failed to load contacts'))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchContacts()
  }, [fetchContacts])

  // Real-time updates via SSE
  useSSE({
    'contact:created': () => fetchContacts(),
    'contact:updated': () => fetchContacts(),
    'contact:deleted': (data) => {
      const contactId = data.contactId as string
      setContacts((prev) => prev.filter((c) => c.id !== contactId))
    },
  })

  const handleDeleteContact = async (id: string) => {
    try {
      await api.delete(`/contacts/${id}`)
      await fetchContacts()
      toast.success(t('settings.contacts.deleted'))
    } catch (err: unknown) {
      toastError(err)
    }
  }

  const handleSaved = async () => {
    await fetchContacts()
    toast.success(editingContact ? t('settings.contacts.saved') : t('settings.contacts.added'))
  }

  const openAdd = () => {
    setEditingContact(null)
    setModalOpen(true)
  }

  const openEdit = (contact: ContactData) => {
    setEditingContact(contact)
    setModalOpen(true)
  }

  if (isLoading) {
    return <SettingsListSkeleton count={3} />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('settings.contacts.description')}
        </p>
      </div>

      <HelpPanel
        contentKey="settings.contacts.help.content"
        bulletKeys={[
          'settings.contacts.help.bullet1',
          'settings.contacts.help.bullet2',
          'settings.contacts.help.bullet3',
          'settings.contacts.help.bullet4',
        ]}
        storageKey="help.contacts.open"
      />

      {contacts.length > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('settings.contacts.search', 'Search contacts...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      )}

      {contacts.length === 0 && (
        <EmptyState
          icon={Users}
          title={t('settings.contacts.empty')}
          description={t('settings.contacts.emptyDescription')}
          actionLabel={t('settings.contacts.add')}
          onAction={openAdd}
        />
      )}

      {filteredContacts.map((contact) => (
        <ContactCard
          key={contact.id}
          contact={contact}
          kinInfo={kinInfo}
          onEdit={() => openEdit(contact)}
          onDelete={() => handleDeleteContact(contact.id)}
          onRefresh={fetchContacts}
        />
      ))}

      <Button variant="outline" onClick={openAdd} className="w-full">
        <Plus className="size-4" />
        {t('settings.contacts.add')}
      </Button>

      <ContactFormDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSaved={handleSaved}
        contact={editingContact}
      />

    </div>
  )
}
