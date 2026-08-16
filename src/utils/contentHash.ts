import * as crypto from 'crypto';

/**
 * SHA-256 content hash of a text payload. Used to detect whether an
 * editor's document content changed since it was last analyzed, so
 * identical content never triggers a redundant re-analysis.
 */
export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}
