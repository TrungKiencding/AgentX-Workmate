import type { DeliverableFile } from '@/store/deliverables'

/**
 * The file a `deliver_file` tool result describes, or `null` when the call
 * failed or the result is not the tool's shape. The result arrives as parsed
 * JSON live (`tool.complete`) and as a JSON string from a stored transcript;
 * both are accepted.
 */
export function deliveredFileFromResult(result: unknown): DeliverableFile | null {
  let record: unknown = result

  if (typeof record === 'string') {
    try {
      record = JSON.parse(record)
    } catch {
      return null
    }
  }

  if (!record || typeof record !== 'object') {
    return null
  }

  const row = record as Record<string, unknown>

  if (row.success !== true || typeof row.path !== 'string' || !row.path) {
    return null
  }

  return {
    caption: typeof row.caption === 'string' && row.caption ? row.caption : undefined,
    mimeType: typeof row.mime_type === 'string' ? row.mime_type : undefined,
    modifiedMs: typeof row.modified_at === 'number' ? row.modified_at * 1000 : undefined,
    name: typeof row.name === 'string' && row.name ? row.name : row.path.split(/[\\/]/).pop() || row.path,
    path: row.path,
    sizeBytes: typeof row.size_bytes === 'number' ? row.size_bytes : undefined
  }
}
