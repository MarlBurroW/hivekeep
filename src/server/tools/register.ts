import { createLogger } from '@/server/logger'
import { toolRegistry } from '@/server/tools/index'
import {
  browseUrlTool,
  extractLinksTool,
  screenshotUrlTool,
} from '@/server/tools/browse-tools'
import {
  listSearchProvidersTool,
  webSearchTool,
} from '@/server/tools/search-tools'
import {
  listEmailAccountsTool,
  listEmailsTool,
  readEmailTool,
  searchEmailsTool,
  sendEmailTool,
  downloadEmailAttachmentTool,
} from '@/server/tools/email-tools'
import {
  listAddressBooksTool,
  listAddressBookContactsTool,
  getAddressBookContactTool,
  searchAddressBookTool,
} from '@/server/tools/address-book-tools'
import {
  listCalendarAccountsTool,
  listCalendarsTool,
  listEventsTool,
  getEventTool,
  createEventTool,
  updateEventTool,
  deleteEventTool,
} from '@/server/tools/calendar-tools'
import {
  listTtsProvidersTool,
  listVoicesTool,
  textToSpeechTool,
  listSttProvidersTool,
  listSttModelsTool,
  transcribeAudioTool,
} from '@/server/tools/voice-tools'
import {
  browserOpenSessionTool,
  browserCloseSessionTool,
  browserListSessionsTool,
  browserNavigateTool,
  browserClickTool,
  browserTypeTool,
  browserSelectTool,
  browserPressKeyTool,
  browserScrollTool,
  browserWaitForTool,
  browserScreenshotTool,
  browserSetCookiesTool,
  browserGetCookiesTool,
  browserClearCookiesTool,
  browserRequestHumanTool,
  browserSaveStateTool,
  browserListStatesTool,
  browserDeleteStateTool,
} from '@/server/tools/browser-session-tools'
import {
  getContactTool,
  searchContactsTool,
  createContactTool,
  updateContactTool,
  deleteContactTool,
  setContactNoteTool,
  findContactByIdentifierTool,
} from '@/server/tools/contact-tools'
import {
  recallTool,
  memorizeTool,
  updateMemoryTool,
  forgetTool,
  listMemoriesTool,
  reviewMemoriesTool,
} from '@/server/tools/memory-tools'
import { searchHistoryTool, browseHistoryTool, listSummariesTool, readSummaryTool } from '@/server/tools/history-tools'
import {
  getSecretTool,
  redactMessageTool,
  createSecretTool,
  updateSecretTool,
  deleteSecretTool,
  searchSecretsTool,
  getVaultEntryTool,
  createVaultEntryTool,
  createVaultTypeTool,
  getVaultAttachmentTool,
} from '@/server/tools/vault-tools'
import {
  spawnSelfTool,
  spawnKinTool,
  respondToTaskTool,
  cancelTaskTool,
  listTasksTool,
  listActiveQueuesTool,
  getTaskDetailTool,
  getTaskMessagesTool,
} from '@/server/tools/task-tools'
import {
  reportToParentTool,
  updateTaskStatusTool,
  requestInputTool,
} from '@/server/tools/subtask-tools'
import { scoutTool } from '@/server/tools/scout-tool'
import { promptHumanTool } from '@/server/tools/human-prompt-tools'
import { notifyTool } from '@/server/tools/notify-tool'
import {
  sendMessageTool,
  replyTool,
  listKinsTool,
} from '@/server/tools/inter-kin-tools'
import {
  createCronTool,
  updateCronTool,
  deleteCronTool,
  listCronsTool,
  getCronJournalTool,
  triggerCronTool,
} from '@/server/tools/cron-tools'
import {
  createCustomToolTool,
  writeCustomToolFileTool,
  runCustomToolSetupTool,
  testCustomToolTool,
  updateCustomToolTool,
  deleteCustomToolTool,
  listCustomToolsTool,
  createToolDomainTool,
  listToolDomainsTool,
  updateToolDomainTool,
  deleteToolDomainTool,
} from '@/server/tools/custom-tool-tools'
import {
  listProjectsTool,
  getProjectTool,
  createProjectTool,
  updateProjectTool,
  deleteProjectTool,
  updateProjectDescriptionTool,
  appendProjectDescriptionTool,
  patchProjectDescriptionTool,
  setActiveProjectTool,
  listProjectTagsTool,
  createTagTool,
  updateTagTool,
  deleteTagTool,
  listTicketsTool,
  getTicketTool,
  createTicketTool,
  updateTicketTool,
  addTicketTagTool,
  removeTicketTagTool,
  deleteTicketTool,
  startTicketTaskTool,
  enrichTicketTool,
  addTicketCommentTool,
  listTicketCommentsTool,
  deleteTicketCommentTool,
} from '@/server/tools/project-tools'
import {
  addProjectKnowledgeTool,
  searchProjectKnowledgeTool,
  listProjectKnowledgeTool,
  getProjectKnowledgeTool,
  updateProjectKnowledgeTool,
  deleteProjectKnowledgeTool,
  pinProjectKnowledgeTool,
} from '@/server/tools/project-knowledge-tools'
import {
  listTicketAttachmentsTool,
  readTicketAttachmentTool,
  addTicketAttachmentTool,
  updateTicketAttachmentTool,
  deleteTicketAttachmentTool,
} from '@/server/tools/ticket-attachment-tools'
import { generateImageTool, listImageModelsTool, describeImageModelTool } from '@/server/tools/image-tools'
import { listProvidersTool, listModelsTool } from '@/server/tools/provider-tools'
import {
  describeProviderConfigTool,
  listProviderTypesTool,
  testProviderTool,
  enableProviderCapabilityTool,
  setDefaultProviderTool,
  setDefaultModelTool,
  getDefaultModelsTool,
  getGlobalPromptTool,
  setGlobalPromptTool,
  getAvatarStyleTool,
  setAvatarStyleTool,
  setAvatarSubjectTool,
  listAvatarPresetsTool,
  setAvatarBaseEnabledTool,
  generateAvatarBaseTool,
  resetAvatarBaseTool,
  testChannelTool,
} from '@/server/tools/config-tools'
import { requestProviderSetupTool, requestChannelSetupTool, promptSecretTool } from '@/server/tools/secure-input-tools'
import { runShellTool } from '@/server/tools/shell-tools'
import {
  addMcpServerTool,
  updateMcpServerTool,
  removeMcpServerTool,
  listMcpServersTool,
} from '@/server/tools/mcp-tools'
import {
  storeFileTool,
  getStoredFileTool,
  listStoredFilesTool,
  searchStoredFilesTool,
  updateStoredFileTool,
  deleteStoredFileTool,
  downloadStoredFileTool,
} from '@/server/tools/file-storage-tools'
import {
  createKinTool,
  updateKinTool,
  deleteKinTool,
  getKinDetailsTool,
} from '@/server/tools/kin-management-tools'
import {
  listToolsTool,
  listToolboxesTool,
  createToolboxTool,
  updateToolboxTool,
  deleteToolboxTool,
} from '@/server/tools/toolbox-tools'
import {
  createWebhookTool,
  updateWebhookTool,
  deleteWebhookTool,
  listWebhooksTool,
} from '@/server/tools/webhook-tools'
import {
  listChannelsTool,
  listChannelConversationsTool,
  listEndpointsTool,
  sendChannelMessageTool,
  sendToContactTool,
  createChannelTool,
  updateChannelTool,
  deleteChannelTool,
  activateChannelTool,
  deactivateChannelTool,
  transferChannelTool,
} from '@/server/tools/channel-tools'
import {
  searchKnowledgeTool,
  listKnowledgeSourcesTool,
} from '@/server/tools/knowledge-tools'
import { getPlatformLogsTool, getPlatformConfigTool, listPlatformConfigOptionsTool, updatePlatformConfigTool, restartPlatformTool } from '@/server/tools/platform-tools'
import { getSystemInfoTool } from '@/server/tools/system-info-tools'
import { httpRequestTool } from '@/server/tools/http-request-tools'
import { executeSqlTool } from '@/server/tools/database-tools'
import {
  listUsersTool,
  getUserTool,
  createInvitationTool,
} from '@/server/tools/user-tools'
import {
  wakeMeInTool,
  wakeMeEveryTool,
  cancelWakeupTool,
  listWakeupsTool,
} from '@/server/tools/wakeup-tools'
import {
  createMiniAppTool,
  updateMiniAppTool,
  deleteMiniAppTool,
  listMiniAppsTool,
  writeMiniAppFileTool,
  readMiniAppFileTool,
  deleteMiniAppFileTool,
  listMiniAppFilesTool,
  getMiniAppStorageTool,
  setMiniAppStorageTool,
  deleteMiniAppStorageTool,
  listMiniAppStorageTool,
  clearMiniAppStorageTool,
  createMiniAppSnapshotTool,
  listMiniAppSnapshotsTool,
  rollbackMiniAppTool,
  generateMiniAppIconTool,
  getMiniAppConsoleTool,
  reloadMiniAppTool,
  editMiniAppFileTool,
  multiEditMiniAppFileTool,
  setMiniAppMaintainerTool,
} from '@/server/tools/mini-app-tools'
import { getMiniAppTemplatesTool } from '@/server/tools/mini-app-templates'
import { getMiniAppDocsTool } from '@/server/tools/mini-app-docs'
import { browseMiniAppsTool } from '@/server/tools/mini-app-gallery'
import {
  saveRunLearningTool,
  deleteRunLearningTool,
} from '@/server/tools/cron-learning-tools'
import { attachFileTool } from '@/server/tools/attach-file-tool'
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
} from '@/server/tools/filesystem-tools'
import { grepTool } from '@/server/tools/grep-tools'
import { multiEditTool } from '@/server/tools/multi-edit-tools'
import { thinkTool } from '@/server/tools/think-tool'
import { taskTodosTool } from '@/server/tools/task-todos-tool'
const log = createLogger('tools')

/**
 * Register all native tools in the tool registry.
 * Called once at server startup.
 *
 * Tools from later phases (tasks, inter-kin, etc.) will be
 * registered here as they are implemented.
 */
export function registerAllTools(): void {
  // Web browsing — read-only one-shot tools
  toolRegistry.register('browse_url', browseUrlTool, 'browse')
  toolRegistry.register('extract_links', extractLinksTool, 'browse')
  toolRegistry.register('screenshot_url', screenshotUrlTool, 'browse')

  // Search tools — discovery + action. Use browse_url for follow-up fetch.
  toolRegistry.register('list_search_providers', listSearchProvidersTool, 'search')
  toolRegistry.register('web_search', webSearchTool, 'search')

  // Email tools — read/search/send through a slug-resolved email account.
  toolRegistry.register('list_email_accounts', listEmailAccountsTool, 'email')
  toolRegistry.register('list_emails', listEmailsTool, 'email')
  toolRegistry.register('read_email', readEmailTool, 'email')
  toolRegistry.register('search_emails', searchEmailsTool, 'email')
  toolRegistry.register('send_email', sendEmailTool, 'email')
  toolRegistry.register('download_email_attachment', downloadEmailAttachmentTool, 'email')

  // Address-book tools — read-only EXTERNAL contacts (iCloud, …), distinct from
  // KinBot's own contacts CRM. Resolved through a slug-based account.
  toolRegistry.register('list_address_books', listAddressBooksTool, 'contacts')
  toolRegistry.register('list_address_book_contacts', listAddressBookContactsTool, 'contacts')
  toolRegistry.register('get_address_book_contact', getAddressBookContactTool, 'contacts')
  toolRegistry.register('search_address_book', searchAddressBookTool, 'contacts')

  // Calendar tools — read + write events on a slug-resolved calendar account.
  toolRegistry.register('list_calendar_accounts', listCalendarAccountsTool, 'calendar')
  toolRegistry.register('list_calendars', listCalendarsTool, 'calendar')
  toolRegistry.register('list_events', listEventsTool, 'calendar')
  toolRegistry.register('get_event', getEventTool, 'calendar')
  toolRegistry.register('create_event', createEventTool, 'calendar')
  toolRegistry.register('update_event', updateEventTool, 'calendar')
  toolRegistry.register('delete_event', deleteEventTool, 'calendar')

  // Voice tools — TTS + STT discovery and actions. Audio bytes flow
  // through the messages-attachment files table (same path as
  // generate_image), never as base64 in the LLM context.
  toolRegistry.register('list_tts_providers', listTtsProvidersTool, 'voice')
  toolRegistry.register('list_voices', listVoicesTool, 'voice')
  toolRegistry.register('text_to_speech', textToSpeechTool, 'voice')
  toolRegistry.register('list_stt_providers', listSttProvidersTool, 'voice')
  toolRegistry.register('list_stt_models', listSttModelsTool, 'voice')
  toolRegistry.register('transcribe_audio', transcribeAudioTool, 'voice')

  // Web browsing — stateful sessions (defaultDisabled: granted only when a toolbox lists them)
  toolRegistry.register('browser_open_session', browserOpenSessionTool, 'browse')
  toolRegistry.register('browser_close_session', browserCloseSessionTool, 'browse')
  toolRegistry.register('browser_list_sessions', browserListSessionsTool, 'browse')
  toolRegistry.register('browser_navigate', browserNavigateTool, 'browse')
  toolRegistry.register('browser_click', browserClickTool, 'browse')
  toolRegistry.register('browser_type', browserTypeTool, 'browse')
  toolRegistry.register('browser_select', browserSelectTool, 'browse')
  toolRegistry.register('browser_press_key', browserPressKeyTool, 'browse')
  toolRegistry.register('browser_scroll', browserScrollTool, 'browse')
  toolRegistry.register('browser_wait_for', browserWaitForTool, 'browse')
  toolRegistry.register('browser_screenshot', browserScreenshotTool, 'browse')
  toolRegistry.register('browser_set_cookies', browserSetCookiesTool, 'browse')
  toolRegistry.register('browser_get_cookies', browserGetCookiesTool, 'browse')
  toolRegistry.register('browser_clear_cookies', browserClearCookiesTool, 'browse')
  toolRegistry.register('browser_request_human', browserRequestHumanTool, 'browse')
  toolRegistry.register('browser_save_state', browserSaveStateTool, 'browse')
  toolRegistry.register('browser_list_states', browserListStatesTool, 'browse')
  toolRegistry.register('browser_delete_state', browserDeleteStateTool, 'browse')

  // Phase 11: Contact tools
  toolRegistry.register('get_contact', getContactTool, 'contacts')
  toolRegistry.register('search_contacts', searchContactsTool, 'contacts')
  toolRegistry.register('create_contact', createContactTool, 'contacts')
  toolRegistry.register('update_contact', updateContactTool, 'contacts')
  toolRegistry.register('delete_contact', deleteContactTool, 'contacts')
  toolRegistry.register('set_contact_note', setContactNoteTool, 'contacts')
  toolRegistry.register('find_contact_by_identifier', findContactByIdentifierTool, 'contacts')

  // Phase 12: Memory tools
  toolRegistry.register('recall', recallTool, 'memory')
  toolRegistry.register('memorize', memorizeTool, 'memory')
  toolRegistry.register('update_memory', updateMemoryTool, 'memory')
  toolRegistry.register('forget', forgetTool, 'memory')
  toolRegistry.register('list_memories', listMemoriesTool, 'memory')
  toolRegistry.register('review_memories', reviewMemoriesTool, 'memory')

  // Phase 12: History tools
  toolRegistry.register('search_history', searchHistoryTool, 'memory')
  toolRegistry.register('browse_history', browseHistoryTool, 'memory')
  toolRegistry.register('list_summaries', listSummariesTool, 'memory')
  toolRegistry.register('read_summary', readSummaryTool, 'memory')

  // Phase 14: Vault tools
  toolRegistry.register('get_secret', getSecretTool, 'vault')
  toolRegistry.register('redact_message', redactMessageTool, 'vault')
  toolRegistry.register('create_secret', createSecretTool, 'vault')
  toolRegistry.register('update_secret', updateSecretTool, 'vault')
  toolRegistry.register('delete_secret', deleteSecretTool, 'vault')
  toolRegistry.register('search_secrets', searchSecretsTool, 'vault')
  toolRegistry.register('get_vault_entry', getVaultEntryTool, 'vault')
  toolRegistry.register('create_vault_entry', createVaultEntryTool, 'vault')
  toolRegistry.register('create_vault_type', createVaultTypeTool, 'vault')
  toolRegistry.register('get_vault_attachment', getVaultAttachmentTool, 'vault')

  // Phase 15: Task tools (parent — main only)
  toolRegistry.register('spawn_self', spawnSelfTool, 'tasks')
  toolRegistry.register('spawn_kin', spawnKinTool, 'tasks')
  toolRegistry.register('respond_to_task', respondToTaskTool, 'tasks')
  toolRegistry.register('cancel_task', cancelTaskTool, 'tasks')
  toolRegistry.register('list_tasks', listTasksTool, 'tasks')
  toolRegistry.register('list_active_queues', listActiveQueuesTool, 'tasks')
  toolRegistry.register('get_task_detail', getTaskDetailTool, 'tasks')
  toolRegistry.register('get_task_messages', getTaskMessagesTool, 'tasks')

  // Scout: cheap read-only delegation (main + sub-kin). Spawns an await child
  // on the scout model with the read-only 'scout' toolbox and blocks for its
  // digest. The 'scout' toolbox excludes scout/spawn tools → scouts are leaves.
  toolRegistry.register('scout', scoutTool, 'tasks')

  // Phase 15: Sub-Kin tools (sub-kin only)
  toolRegistry.register('report_to_parent', reportToParentTool, 'tasks')
  toolRegistry.register('update_task_status', updateTaskStatusTool, 'tasks')
  toolRegistry.register('request_input', requestInputTool, 'tasks')

  // Cron learning tools (sub-kin only, active during cron tasks)
  toolRegistry.register('save_run_learning', saveRunLearningTool, 'tasks')
  toolRegistry.register('delete_run_learning', deleteRunLearningTool, 'tasks')

  // Human-in-the-loop (main + sub-kin)
  toolRegistry.register('prompt_human', promptHumanTool, 'tasks')
  toolRegistry.register('notify', notifyTool, 'tasks')

  // Phase 16: Inter-Kin tools (main only)
  toolRegistry.register('send_message', sendMessageTool, 'inter-kin')
  toolRegistry.register('reply', replyTool, 'inter-kin')
  toolRegistry.register('list_kins', listKinsTool, 'inter-kin')

  // Phase 17: Cron tools (main only)
  toolRegistry.register('create_cron', createCronTool, 'crons')
  toolRegistry.register('update_cron', updateCronTool, 'crons')
  toolRegistry.register('delete_cron', deleteCronTool, 'crons')
  toolRegistry.register('list_crons', listCronsTool, 'crons')
  toolRegistry.register('get_cron_journal', getCronJournalTool, 'crons')
  toolRegistry.register('trigger_cron', triggerCronTool, 'crons')

  // Phase 26: Project & ticket tools
  // Main agents get the full set ; sub-Kins only get read/update tools when their task has ticket_id set (cf. project-tools.ts).
  toolRegistry.register('list_projects', listProjectsTool, 'projects')
  toolRegistry.register('get_project', getProjectTool, 'projects')
  toolRegistry.register('create_project', createProjectTool, 'projects')
  toolRegistry.register('update_project', updateProjectTool, 'projects')
  toolRegistry.register('delete_project', deleteProjectTool, 'projects')
  toolRegistry.register('update_project_description', updateProjectDescriptionTool, 'projects')
  toolRegistry.register('append_project_description', appendProjectDescriptionTool, 'projects')
  toolRegistry.register('patch_project_description', patchProjectDescriptionTool, 'projects')
  toolRegistry.register('set_active_project', setActiveProjectTool, 'projects')
  toolRegistry.register('list_project_tags', listProjectTagsTool, 'projects')
  toolRegistry.register('create_tag', createTagTool, 'projects')
  toolRegistry.register('update_tag', updateTagTool, 'projects')
  toolRegistry.register('delete_tag', deleteTagTool, 'projects')
  toolRegistry.register('list_tickets', listTicketsTool, 'projects')
  toolRegistry.register('get_ticket', getTicketTool, 'projects')
  toolRegistry.register('create_ticket', createTicketTool, 'projects')
  toolRegistry.register('update_ticket', updateTicketTool, 'projects')
  toolRegistry.register('add_ticket_tag', addTicketTagTool, 'projects')
  toolRegistry.register('remove_ticket_tag', removeTicketTagTool, 'projects')
  toolRegistry.register('delete_ticket', deleteTicketTool, 'projects')
  toolRegistry.register('start_ticket_task', startTicketTaskTool, 'projects')
  toolRegistry.register('enrich_ticket', enrichTicketTool, 'projects')
  toolRegistry.register('add_ticket_comment', addTicketCommentTool, 'projects')
  toolRegistry.register('list_ticket_comments', listTicketCommentsTool, 'projects')
  toolRegistry.register('delete_ticket_comment', deleteTicketCommentTool, 'projects')
  toolRegistry.register('list_ticket_attachments', listTicketAttachmentsTool, 'projects')
  toolRegistry.register('read_ticket_attachment', readTicketAttachmentTool, 'projects')
  toolRegistry.register('add_ticket_attachment', addTicketAttachmentTool, 'projects')
  toolRegistry.register('update_ticket_attachment', updateTicketAttachmentTool, 'projects')
  toolRegistry.register('delete_ticket_attachment', deleteTicketAttachmentTool, 'projects')

  // Project knowledge: curated facts/decisions/gotchas per project, available
  // to main Kins (active project) and ticket-bound sub-Kins (ticket's project).
  // Every entry's title lands in the system-prompt index. Pinned entries
  // (max config.projectKnowledge.pinCap) ALSO inline their markdown body in
  // the prompt — unpinned ones are fetched on demand via get_project_knowledge.
  toolRegistry.register('add_project_knowledge', addProjectKnowledgeTool, 'projects')
  toolRegistry.register('search_project_knowledge', searchProjectKnowledgeTool, 'projects')
  toolRegistry.register('list_project_knowledge', listProjectKnowledgeTool, 'projects')
  toolRegistry.register('get_project_knowledge', getProjectKnowledgeTool, 'projects')
  toolRegistry.register('update_project_knowledge', updateProjectKnowledgeTool, 'projects')
  toolRegistry.register('delete_project_knowledge', deleteProjectKnowledgeTool, 'projects')
  toolRegistry.register('pin_project_knowledge', pinProjectKnowledgeTool, 'projects')

  // Custom tools (GLOBAL, first-class). Authoring/admin tools are main-only;
  // the resulting tools are exposed separately as `custom_<slug>` (resolved by
  // services/custom-tools.ts, MCP-style — not registered here).
  toolRegistry.register('create_custom_tool', createCustomToolTool, 'custom')
  toolRegistry.register('write_custom_tool_file', writeCustomToolFileTool, 'custom')
  toolRegistry.register('run_custom_tool_setup', runCustomToolSetupTool, 'custom')
  toolRegistry.register('test_custom_tool', testCustomToolTool, 'custom')
  toolRegistry.register('update_custom_tool', updateCustomToolTool, 'custom')
  toolRegistry.register('delete_custom_tool', deleteCustomToolTool, 'custom')
  toolRegistry.register('list_custom_tools', listCustomToolsTool, 'custom')
  toolRegistry.register('create_tool_domain', createToolDomainTool, 'custom')
  toolRegistry.register('list_tool_domains', listToolDomainsTool, 'custom')
  toolRegistry.register('update_tool_domain', updateToolDomainTool, 'custom')
  toolRegistry.register('delete_tool_domain', deleteToolDomainTool, 'custom')

  // Phase 21: Image tools
  toolRegistry.register('generate_image', generateImageTool, 'images')
  toolRegistry.register('list_image_models', listImageModelsTool, 'images')
  toolRegistry.register('describe_image_model', describeImageModelTool, 'images')

  // Provider & model discovery tools (main + sub-kin)
  toolRegistry.register('list_providers', listProvidersTool, 'system')
  toolRegistry.register('list_models', listModelsTool, 'system')

  // Platform configuration tools (configurator Kin / admin) — provider config
  // discovery + capability/default management + global prompt. Mutations are
  // admin-only (enforced inside each tool).
  toolRegistry.register('describe_provider_config', describeProviderConfigTool, 'system')
  toolRegistry.register('list_provider_types', listProviderTypesTool, 'system')
  toolRegistry.register('test_provider', testProviderTool, 'system')
  toolRegistry.register('enable_provider_capability', enableProviderCapabilityTool, 'system')
  toolRegistry.register('set_default_provider', setDefaultProviderTool, 'system')
  toolRegistry.register('set_default_model', setDefaultModelTool, 'system')
  toolRegistry.register('get_default_models', getDefaultModelsTool, 'system')
  toolRegistry.register('get_global_prompt', getGlobalPromptTool, 'system')
  toolRegistry.register('set_global_prompt', setGlobalPromptTool, 'system')
  toolRegistry.register('get_avatar_style', getAvatarStyleTool, 'system')
  toolRegistry.register('set_avatar_style', setAvatarStyleTool, 'system')
  toolRegistry.register('set_avatar_subject', setAvatarSubjectTool, 'system')
  toolRegistry.register('list_avatar_presets', listAvatarPresetsTool, 'system')
  toolRegistry.register('set_avatar_base_enabled', setAvatarBaseEnabledTool, 'system')
  toolRegistry.register('generate_avatar_base', generateAvatarBaseTool, 'system')
  toolRegistry.register('reset_avatar_base', resetAvatarBaseTool, 'system')
  toolRegistry.register('test_channel', testChannelTool, 'system')

  // Secure-input tools (configurator Kin) — request a secret via UI popup; the
  // value goes straight to the vault / encrypted provider config, never to the LLM.
  toolRegistry.register('request_provider_setup', requestProviderSetupTool, 'system')
  toolRegistry.register('request_channel_setup', requestChannelSetupTool, 'system')
  toolRegistry.register('prompt_secret', promptSecretTool, 'system')

  // Phase 18: MCP management tools (main only)
  toolRegistry.register('add_mcp_server', addMcpServerTool, 'mcp')
  toolRegistry.register('update_mcp_server', updateMcpServerTool, 'mcp')
  toolRegistry.register('remove_mcp_server', removeMcpServerTool, 'mcp')
  toolRegistry.register('list_mcp_servers', listMcpServersTool, 'mcp')

  // Shell execution (main + sub-kin)
  toolRegistry.register('run_shell', runShellTool, 'shell')

  // File storage tools (main only)
  toolRegistry.register('store_file', storeFileTool, 'file-storage')
  toolRegistry.register('get_stored_file', getStoredFileTool, 'file-storage')
  toolRegistry.register('download_stored_file', downloadStoredFileTool, 'file-storage')
  toolRegistry.register('list_stored_files', listStoredFilesTool, 'file-storage')
  toolRegistry.register('search_stored_files', searchStoredFilesTool, 'file-storage')
  toolRegistry.register('update_stored_file', updateStoredFileTool, 'file-storage')
  toolRegistry.register('delete_stored_file', deleteStoredFileTool, 'file-storage')

  // Kin management tools (main only, opt-in required)
  toolRegistry.register('create_kin', createKinTool, 'kin-management')
  toolRegistry.register('update_kin', updateKinTool, 'kin-management')
  toolRegistry.register('delete_kin', deleteKinTool, 'kin-management')
  toolRegistry.register('get_kin_details', getKinDetailsTool, 'kin-management')
  toolRegistry.register('list_toolboxes', listToolboxesTool, 'kin-management')
  toolRegistry.register('list_tools', listToolsTool, 'kin-management')
  toolRegistry.register('create_toolbox', createToolboxTool, 'kin-management')
  toolRegistry.register('update_toolbox', updateToolboxTool, 'kin-management')
  toolRegistry.register('delete_toolbox', deleteToolboxTool, 'kin-management')

  // Webhook tools (main only)
  toolRegistry.register('create_webhook', createWebhookTool, 'webhooks')
  toolRegistry.register('update_webhook', updateWebhookTool, 'webhooks')
  toolRegistry.register('delete_webhook', deleteWebhookTool, 'webhooks')
  toolRegistry.register('list_webhooks', listWebhooksTool, 'webhooks')

  // Channel tools (main only, send_channel_message/create/update/delete are opt-in)
  toolRegistry.register('list_channels', listChannelsTool, 'channels')
  toolRegistry.register('list_channel_conversations', listChannelConversationsTool, 'channels')
  toolRegistry.register('list_endpoints', listEndpointsTool, 'channels')
  toolRegistry.register('send_channel_message', sendChannelMessageTool, 'channels')
  toolRegistry.register('send_to_contact', sendToContactTool, 'channels')
  toolRegistry.register('create_channel', createChannelTool, 'channels')
  toolRegistry.register('update_channel', updateChannelTool, 'channels')
  toolRegistry.register('delete_channel', deleteChannelTool, 'channels')
  toolRegistry.register('activate_channel', activateChannelTool, 'channels')
  toolRegistry.register('deactivate_channel', deactivateChannelTool, 'channels')
  toolRegistry.register('transfer_channel', transferChannelTool, 'channels')
  toolRegistry.register('attach_file', attachFileTool, 'channels')

  // Platform / system tools (main only, opt-in required)
  toolRegistry.register('get_platform_logs', getPlatformLogsTool, 'system')
  toolRegistry.register('get_platform_config', getPlatformConfigTool, 'system')
  toolRegistry.register('list_platform_config_options', listPlatformConfigOptionsTool, 'system')
  toolRegistry.register('update_platform_config', updatePlatformConfigTool, 'system')
  toolRegistry.register('restart_platform', restartPlatformTool, 'system')
  toolRegistry.register('get_system_info', getSystemInfoTool, 'system')
  toolRegistry.register('http_request', httpRequestTool, 'browse')

  // Database tools (main only, opt-in required — God Tier)
  toolRegistry.register('execute_sql', executeSqlTool, 'database')

  // User management tools (main only)
  toolRegistry.register('list_users', listUsersTool, 'users')
  toolRegistry.register('get_user', getUserTool, 'users')
  toolRegistry.register('create_invitation', createInvitationTool, 'users')

  // Wake-up scheduler tools (main only)
  toolRegistry.register('wake_me_in', wakeMeInTool, 'crons')
  toolRegistry.register('wake_me_every', wakeMeEveryTool, 'crons')
  toolRegistry.register('cancel_wakeup', cancelWakeupTool, 'crons')
  toolRegistry.register('list_wakeups', listWakeupsTool, 'crons')

  // Mini-App tools (main only)
  toolRegistry.register('create_mini_app', createMiniAppTool, 'mini-apps')
  toolRegistry.register('update_mini_app', updateMiniAppTool, 'mini-apps')
  toolRegistry.register('delete_mini_app', deleteMiniAppTool, 'mini-apps')
  toolRegistry.register('list_mini_apps', listMiniAppsTool, 'mini-apps')
  toolRegistry.register('write_mini_app_file', writeMiniAppFileTool, 'mini-apps')
  toolRegistry.register('read_mini_app_file', readMiniAppFileTool, 'mini-apps')
  toolRegistry.register('delete_mini_app_file', deleteMiniAppFileTool, 'mini-apps')
  toolRegistry.register('list_mini_app_files', listMiniAppFilesTool, 'mini-apps')
  toolRegistry.register('get_mini_app_storage', getMiniAppStorageTool, 'mini-apps')
  toolRegistry.register('set_mini_app_storage', setMiniAppStorageTool, 'mini-apps')
  toolRegistry.register('delete_mini_app_storage', deleteMiniAppStorageTool, 'mini-apps')
  toolRegistry.register('list_mini_app_storage', listMiniAppStorageTool, 'mini-apps')
  toolRegistry.register('clear_mini_app_storage', clearMiniAppStorageTool, 'mini-apps')
  toolRegistry.register('create_mini_app_snapshot', createMiniAppSnapshotTool, 'mini-apps')
  toolRegistry.register('list_mini_app_snapshots', listMiniAppSnapshotsTool, 'mini-apps')
  toolRegistry.register('rollback_mini_app', rollbackMiniAppTool, 'mini-apps')
  toolRegistry.register('get_mini_app_templates', getMiniAppTemplatesTool, 'mini-apps')
  toolRegistry.register('get_mini_app_docs', getMiniAppDocsTool, 'mini-apps')
  toolRegistry.register('browse_mini_apps', browseMiniAppsTool, 'mini-apps')
  toolRegistry.register('generate_mini_app_icon', generateMiniAppIconTool, 'mini-apps')
  toolRegistry.register('get_mini_app_console', getMiniAppConsoleTool, 'mini-apps')
  toolRegistry.register('reload_mini_app', reloadMiniAppTool, 'mini-apps')
  toolRegistry.register('edit_mini_app_file', editMiniAppFileTool, 'mini-apps')
  toolRegistry.register('multi_edit_mini_app_file', multiEditMiniAppFileTool, 'mini-apps')
  toolRegistry.register('set_mini_app_maintainer', setMiniAppMaintainerTool, 'mini-apps')

  // Filesystem tools (main + sub-kin)
  toolRegistry.register('read_file', readFileTool, 'filesystem')
  toolRegistry.register('write_file', writeFileTool, 'filesystem')
  toolRegistry.register('edit_file', editFileTool, 'filesystem')
  toolRegistry.register('multi_edit', multiEditTool, 'filesystem')
  toolRegistry.register('list_directory', listDirectoryTool, 'filesystem')
  toolRegistry.register('grep', grepTool, 'filesystem')

  // Reasoning aid: free-form thought logger, no side effects.
  toolRegistry.register('think', thinkTool, 'tasks')

  // Sub-Kin structured planning (TodoWrite-equivalent).
  toolRegistry.register('task_todos', taskTodosTool, 'tasks')

  // Knowledge base tools (main only)
  toolRegistry.register('search_knowledge', searchKnowledgeTool, 'memory')
  toolRegistry.register('list_knowledge_sources', listKnowledgeSourcesTool, 'memory')

  log.info({ count: toolRegistry.registeredCount }, 'Native tools registered')
}
