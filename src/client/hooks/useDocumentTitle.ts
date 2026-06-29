import { useEffect } from 'react'

const BASE_TITLE = 'Gezy'

/**
 * Update the browser tab title dynamically.
 *
 * Shows the selected Agent name, a typing indicator when processing,
 * and an unread message count badge when there are unseen messages
 * (e.g. when the tab was in the background).
 */
export function useDocumentTitle(
  agentName?: string | null,
  isProcessing?: boolean,
  unreadCount?: number,
) {
  useEffect(() => {
    if (!agentName) {
      document.title = unreadCount
        ? `(${unreadCount}) ${BASE_TITLE}`
        : BASE_TITLE
      return
    }

    const badge = unreadCount ? `(${unreadCount}) ` : ''

    document.title = isProcessing
      ? `${badge}✦ ${agentName} · ${BASE_TITLE}`
      : `${badge}${agentName} · ${BASE_TITLE}`

    return () => {
      document.title = BASE_TITLE
    }
  }, [agentName, isProcessing, unreadCount])
}
