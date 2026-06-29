import { eq, inArray, and, lt, isNull } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { join } from "path";
import { mkdir } from "fs/promises";
import { db } from "@/server/db/index";
import { createLogger } from "@/server/logger";
import { files } from "@/server/db/schema";
import { config } from "@/server/config";
import type { IncomingAttachment } from "@/server/channels/adapter";

const log = createLogger("files");

// ─── Upload ──────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = config.upload.maxFileSizeMb * 1024 * 1024;

interface UploadParams {
  agentId: string;
  uploadedBy: string;
  file: File;
}

export async function uploadFile(params: UploadParams) {
  const { agentId, uploadedBy, file } = params;

  // Validate size
  if (file.size > MAX_FILE_SIZE) {
    log.warn(
      { fileName: file.name, size: file.size },
      "File upload rejected: too large",
    );
    throw new Error(`File too large: max ${config.upload.maxFileSizeMb} MB`);
  }

  if (file.size === 0) {
    throw new Error("File is empty");
  }

  const id = uuid();
  const ext = getExtension(file.name);
  const storedName = `${id}${ext ? `.${ext}` : ""}`;
  const dir = join(config.upload.dir, "messages", agentId);
  const storedPath = join(dir, storedName);

  // Ensure directory exists
  await mkdir(dir, { recursive: true });

  // Write file to disk
  const buffer = await file.arrayBuffer();
  await Bun.write(storedPath, buffer);

  // Save to DB
  await db.insert(files).values({
    id,
    agentId,
    uploadedBy,
    originalName: file.name,
    storedPath,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    createdAt: new Date(),
  });

  log.info(
    {
      agentId,
      fileId: id,
      fileName: file.name,
      size: file.size,
      mimeType: file.type,
    },
    "File uploaded",
  );

  return {
    id,
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    url: `/api/uploads/messages/${agentId}/${storedName}`,
  };
}

// ─── Link files to a message ─────────────────────────────────────────────────

export async function linkFilesToMessage(fileIds: string[], messageId: string) {
  for (const fileId of fileIds) {
    await db.update(files).set({ messageId }).where(eq(files.id, fileId));
  }
}

// ─── Get files for a message ─────────────────────────────────────────────────

export async function getFilesForMessage(messageId: string) {
  return db.select().from(files).where(eq(files.messageId, messageId)).all();
}

// ─── Get files for multiple messages ─────────────────────────────────────────

export async function getFilesForMessages(messageIds: string[]) {
  if (messageIds.length === 0)
    return new Map<string, (typeof files.$inferSelect)[]>();

  const matchedFiles = await db
    .select()
    .from(files)
    .where(inArray(files.messageId, messageIds))
    .all();

  const fileMap = new Map<string, (typeof files.$inferSelect)[]>();
  for (const f of matchedFiles) {
    if (!f.messageId) continue;
    const existing = fileMap.get(f.messageId) ?? [];
    existing.push(f);
    fileMap.set(f.messageId, existing);
  }

  return fileMap;
}

// ─── Serialize file for API response ─────────────────────────────────────────

export function serializeFile(f: typeof files.$inferSelect) {
  const ext = getExtension(f.originalName);
  const storedName = `${f.id}${ext ? `.${ext}` : ""}`;
  return {
    id: f.id,
    name: f.originalName,
    mimeType: f.mimeType,
    size: f.size,
    url: `/api/uploads/messages/${f.agentId}/${storedName}`,
  };
}

// ─── Download & store channel attachments ────────────────────────────────────

/** Map of MIME types to file extensions for when no filename is provided */
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "mp4a",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

interface DownloadAttachmentParams {
  agentId: string;
  attachment: IncomingAttachment;
  /** Direct download URL (may differ from attachment.url, e.g. Telegram getFile URL) */
  downloadUrl: string;
}

/**
 * Download a single channel attachment from a URL and store it locally.
 * Returns the file ID for queue sideband, or null if download failed.
 */
export async function downloadAndStoreAttachment(
  params: DownloadAttachmentParams,
): Promise<string | null> {
  const { agentId, attachment, downloadUrl } = params;

  try {
    const fetchOpts: RequestInit = {};
    if (attachment.headers) {
      fetchOpts.headers = attachment.headers;
    }
    const response = await fetch(downloadUrl, fetchOpts);
    if (!response.ok) {
      log.warn(
        { url: downloadUrl, status: response.status },
        "Failed to download channel attachment",
      );
      return null;
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) {
      log.warn({ url: downloadUrl }, "Channel attachment is empty");
      return null;
    }

    // Enforce size limit
    if (buffer.byteLength > MAX_FILE_SIZE) {
      log.warn(
        { url: downloadUrl, size: buffer.byteLength },
        "Channel attachment too large, skipping",
      );
      return null;
    }

    // Determine MIME type: attachment metadata > response header > fallback
    const mimeType =
      attachment.mimeType ??
      response.headers.get("content-type")?.split(";")[0]?.trim() ??
      "application/octet-stream";

    // Determine filename
    const fileName =
      attachment.fileName ?? guessFilename(downloadUrl, mimeType);

    const id = uuid();
    const ext = getExtension(fileName);
    const storedName = `${id}${ext ? `.${ext}` : ""}`;
    const dir = join(config.upload.dir, "messages", agentId);
    const storedPath = join(dir, storedName);

    await mkdir(dir, { recursive: true });
    await Bun.write(storedPath, buffer);

    await db.insert(files).values({
      id,
      agentId,
      uploadedBy: null,
      originalName: fileName,
      storedPath,
      mimeType,
      size: buffer.byteLength,
      createdAt: new Date(),
    });

    log.info(
      { agentId, fileId: id, fileName, size: buffer.byteLength, mimeType },
      "Channel attachment downloaded and stored",
    );

    return id;
  } catch (err) {
    log.error(
      { url: downloadUrl, err },
      "Error downloading channel attachment",
    );
    return null;
  }
}

// ─── Channel attachment download result types ────────────────────────────────

export interface FailedAttachmentInfo {
  mimeType?: string;
  fileName?: string;
  reason: string;
}

export interface DownloadChannelAttachmentsResult {
  fileIds: string[];
  failedAttachments: FailedAttachmentInfo[];
}

/**
 * Download and store multiple channel attachments.
 * Returns successful file IDs and info about failed attachments.
 */
export async function downloadChannelAttachments(
  agentId: string,
  attachments: IncomingAttachment[],
): Promise<DownloadChannelAttachmentsResult> {
  const fileIds: string[] = [];
  const failedAttachments: FailedAttachmentInfo[] = [];

  for (const attachment of attachments) {
    const downloadUrl = attachment.url;
    if (!downloadUrl) {
      log.warn(
        {
          platformFileId: attachment.platformFileId,
          fileName: attachment.fileName,
        },
        "Attachment has no download URL, skipping",
      );
      failedAttachments.push({
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        reason: "Could not resolve download URL from platform",
      });
      continue;
    }

    const fileId = await downloadAndStoreAttachment({
      agentId,
      attachment,
      downloadUrl,
    });
    if (fileId) {
      fileIds.push(fileId);
    } else {
      failedAttachments.push({
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        reason: "Download failed",
      });
    }
  }

  return { fileIds, failedAttachments };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getExtension(filename: string): string {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop()! : "";
}

// ─── Channel file cleanup ────────────────────────────────────────────────────

/**
 * Delete channel-downloaded files older than the configured retention period.
 * Removes both DB records and files on disk.
 */
export async function pruneOldChannelFiles(): Promise<number> {
  const retentionDays = config.upload.channelFileRetentionDays;
  if (retentionDays <= 0) return 0;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const oldFiles = await db
    .select({ id: files.id, storedPath: files.storedPath })
    .from(files)
    .where(and(isNull(files.uploadedBy), lt(files.createdAt, cutoff)));

  if (oldFiles.length === 0) return 0;

  // Delete files from disk
  const { unlink } = await import("fs/promises");
  for (const f of oldFiles) {
    try {
      await unlink(f.storedPath);
    } catch {
      // File may already be missing
    }
  }

  // Delete DB records
  const ids = oldFiles.map((f) => f.id);
  await db.delete(files).where(inArray(files.id, ids));

  log.info(
    { count: oldFiles.length, retentionDays },
    "Pruned old channel files",
  );
  return oldFiles.length;
}

/** Start periodic cleanup of old channel files. */
export function startChannelFileCleanup(): void {
  const intervalMin = config.upload.channelFileCleanupIntervalMin;
  if (intervalMin <= 0 || config.upload.channelFileRetentionDays <= 0) return;

  // Run once on startup (delayed 30s)
  setTimeout(
    () =>
      pruneOldChannelFiles().catch((e) =>
        log.error(e, "Channel file cleanup failed"),
      ),
    30_000,
  );

  // Then at configured interval
  setInterval(
    () =>
      pruneOldChannelFiles().catch((e) =>
        log.error(e, "Channel file cleanup failed"),
      ),
    intervalMin * 60 * 1000,
  );

  log.info(
    { intervalMin, retentionDays: config.upload.channelFileRetentionDays },
    "Channel file cleanup scheduled",
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Guess a filename from a URL and MIME type when no original name is available */
function guessFilename(url: string, mimeType: string): string {
  // Try to extract filename from URL path
  try {
    const pathname = new URL(url).pathname;
    const basename = pathname.split("/").pop();
    if (basename && basename.includes(".")) return basename;
  } catch {
    // Not a valid URL, ignore
  }

  // Fall back to MIME-based name
  const ext = MIME_TO_EXT[mimeType] ?? "bin";
  return `attachment.${ext}`;
}
