import type { BookMetadata } from '@kashshaf/shared';
import { BookDetail } from './BookDetail';

/**
 * The open text's metadata (9 D), read-only.
 *
 * It is `BookDetail` with none of the workspace's buttons: the same record
 * the browser shows before a text is added, shown again while reading it,
 * from one component so the two cannot drift apart.
 */
export function MetadataPanel({
  book,
  authorName,
  genreName,
}: {
  book: BookMetadata;
  authorName?: string;
  genreName?: string;
}) {
  return (
    <div className="flex-1 min-w-0 flex min-h-0" data-testid="metadata-panel">
      <BookDetail book={book} authorName={authorName} genreName={genreName} />
    </div>
  );
}
