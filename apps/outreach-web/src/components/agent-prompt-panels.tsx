import { AGENT_PROMPT_VERSIONS_SHOWN, type AgentPromptPlaceholder, type AgentPromptVersionSummary } from '@cti/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/outreach-words';

const SYNTAX_WORDS =
  'A text placeholder is written {{name}} and is replaced by its value. A section is written {{#name}} … {{/name}}: what is inside shows only when the section applies, and {{^name}} … {{/name}} shows its opposite.';

/** The names the template may use, from the server (it owns them): name, kind, and what each stands for. */
export function PlaceholderList({ placeholders }: { placeholders: readonly AgentPromptPlaceholder[] }) {
  return (
    <details className="rounded-xl border bg-card">
      <summary className="cursor-pointer px-5 py-3 text-sm font-medium sm:px-6">Placeholders you can use</summary>
      <div className="space-y-3 border-t px-5 py-4 sm:px-6">
        <p className="text-[13px] leading-5 text-muted-foreground">{SYNTAX_WORDS}</p>
        <ul aria-label="Placeholders" className="divide-y">
          {placeholders.map((p) => (
            <li key={p.name} className="grid gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[13rem_5rem_minmax(0,1fr)] sm:items-baseline">
              <code className="font-mono text-[13px] break-all">{p.name}</code>
              <Badge variant="neutral" className="w-fit">{p.kind}</Badge>
              <span className="text-[13px] leading-5 text-muted-foreground">{p.description}</span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

interface VersionListProps {
  versions: readonly AgentPromptVersionSummary[];
  /** The version being fetched, if any. */
  loadingId: string | null;
  /** Off while a save or another load is under way. */
  disabled: boolean;
  onLoad: (id: string) => void;
  /** A failed load, in words. */
  error: string | null;
}

/** The newest saved versions, newest first. "Load" puts one in the editor, unsaved. */
export function VersionList({ versions, loadingId, disabled, onLoad, error }: VersionListProps) {
  return (
    <section aria-labelledby="previous-versions" className="space-y-3 rounded-xl border bg-card px-5 py-4 sm:px-6">
      <div>
        <h2 id="previous-versions" className="text-[15px] leading-6 font-semibold tracking-[-0.01em]">Previous versions</h2>
        <p className="text-[13px] leading-5 text-muted-foreground">{`Newest first, up to ${AGENT_PROMPT_VERSIONS_SHOWN} shown. Loading one only fills the editor: nothing is saved until you press Save.`}</p>
      </div>
      {versions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No earlier versions yet.</p>
      ) : (
        <ul aria-label="Previous versions" className="divide-y">
          {versions.map((v) => {
            const when = formatDateTime(v.createdAt);
            return (
              <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 text-sm">
                <span className="font-medium">{when}</span>
                <span className="min-w-0 break-all text-muted-foreground">{v.createdByEmail ?? 'unknown'}</span>
                {v.isDefault ? <Badge variant="neutral">default</Badge> : <span className="text-xs text-muted-foreground">{`${v.chars.toLocaleString('en-US')} characters`}</span>}
                <Button size="sm" variant="outline" className="ml-auto" aria-label={`Load the version saved ${when}`} disabled={disabled} onClick={() => onLoad(v.id)}>
                  {loadingId === v.id ? 'Loading…' : 'Load'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
