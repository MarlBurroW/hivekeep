export class QueueAttachmentConflictError extends Error {
  constructor() { super('Attachments are unavailable or already queued') }
}
