// Shared attachment plumbing — originally lived only inside SupportTicketsPage.tsx
// (MIGRATION_059's ticket/reply attachments); factored out here so
// ApprovalWorkflowModal.tsx and SupportTicketsPage.tsx's own inline ITSM approval UI
// (MIGRATION_062 — attachments on Return-for-Changes/Resubmit) can share one
// implementation instead of drifting into two copies. Same convention throughout
// this app: a file is read client-side into a `data:` URL and stored as-is, no S3/
// object storage.
export interface Attachment {
  file_name: string;
  file_base64: string;
}

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB decoded, per file — mirrors backend/src/utils/attachments.ts

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Shared render for an Attachment[] array. Images render as an actual clickable
// thumbnail (opens the full data: URL in a new tab); anything else renders as a
// small document chip that downloads on click.
export function AttachmentGallery({ attachments }: { attachments: Attachment[] }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
      {attachments.map((a, i) =>
        a.file_base64.startsWith('data:image/') ? (
          <a key={`${a.file_name}-${i}`} href={a.file_base64} target="_blank" rel="noreferrer" title={a.file_name}>
            <img
              src={a.file_base64}
              alt={a.file_name}
              style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }}
            />
          </a>
        ) : (
          <a
            key={`${a.file_name}-${i}`}
            href={a.file_base64}
            download={a.file_name}
            title={a.file_name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              fontSize: 12,
              maxWidth: 180,
              textDecoration: 'none',
              color: 'inherit',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.file_name}</span>
          </a>
        )
      )}
    </div>
  );
}

// Adds newly-picked files to a staged-files list, enforcing the same per-file size
// cap and total-count cap the backend validator (utils/attachments.ts) re-checks
// server-side. Returns the new array to setState with, or null if it rejected the
// pick (caller should show onError's message and leave state untouched).
export function addStagedFiles(
  prev: File[],
  files: FileList | null,
  onError: (message: string) => void,
  tooLargeMessage: (name: string) => string,
  tooManyMessage: (max: number) => string
): File[] | null {
  if (!files) return null;
  const picked = Array.from(files);
  const tooBig = picked.find((f) => f.size > MAX_ATTACHMENT_BYTES);
  if (tooBig) {
    onError(tooLargeMessage(tooBig.name));
    return null;
  }
  const combined = [...prev, ...picked];
  if (combined.length > MAX_ATTACHMENTS) {
    onError(tooManyMessage(MAX_ATTACHMENTS));
    return null;
  }
  return combined;
}
