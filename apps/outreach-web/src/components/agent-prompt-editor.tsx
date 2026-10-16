import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { AGENT_PROMPT_MAX_CHARS, type AgentPromptKind, type AgentPromptsResponse, type AgentPromptState } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { agentPromptErrorText, characterCountWords, promptProblems, promptStatusWords, versionLoadErrorText } from '@/lib/agent-prompt-words';
import { getAgentPromptVersion, outreachKeys, previewAgentPrompt, saveAgentPrompt } from '@/lib/outreach-api';
import { cn } from '@/lib/utils';
import { StatusBadge } from './layout/status-badge';
import { PlaceholderList, VersionList } from './agent-prompt-panels';
import { ConfirmAction } from './confirm-action';

export const KIND_LABELS: Readonly<Record<AgentPromptKind, string>> = { instructions: 'Call instructions', voicemail: 'Voicemail message' };
const SAVED_WORDS = 'Saved — the next call uses it.';
const RESET_WORDS = 'Back to the default — the next call uses it.';
const REPLACE_WORDS = 'Replace your unsaved changes with this version?';

/** The problems a refused save lists, or the one sentence the failure comes to. */
function SaveFailure({ error }: { error: unknown }) {
  const problems = promptProblems(error);
  if (problems === null) return <p role="alert" className="text-sm text-destructive">{agentPromptErrorText(error)}</p>;
  return (
    <div role="alert" className="space-y-1 rounded-lg border border-destructive/30 bg-danger-soft px-3.5 py-3 text-sm text-destructive">
      <p className="font-medium">Not saved. Fix these first:</p>
      <ul className="list-disc space-y-0.5 pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
    </div>
  );
}

/** The sample call a draft renders to, or the problems that stopped it. */
function PreviewPanel({ rendered, problems }: { rendered: string | null; problems: readonly string[] }) {
  return (
    <section aria-label="Preview" className="space-y-2 rounded-xl border bg-muted/40 px-5 py-4 sm:px-6">
      <h2 className="text-[15px] leading-6 font-semibold tracking-[-0.01em]">Preview with a sample lead</h2>
      {problems.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-destructive">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      ) : (
        <pre className="font-mono text-[13px] leading-5 break-words whitespace-pre-wrap">{rendered ?? ''}</pre>
      )}
    </section>
  );
}

interface PromptEditorProps {
  kind: AgentPromptKind;
  state: AgentPromptState;
  /** Tells the page whether the text differs from what is saved (to guard tab switches and leaving). */
  onDirtyChange: (dirty: boolean) => void;
}

/**
 * One text's editor: status line, the textarea, Save / Preview / Reset to default, the preview panel, the placeholders and
 * the previous versions. The draft lives here, so switching to the other tab (a new editor) drops it, after the page asked.
 */
export function PromptEditor({ kind, state, onDirtyChange }: PromptEditorProps) {
  const qc = useQueryClient();
  const countId = useId();
  const label = KIND_LABELS[kind];
  const baseline = state.active ?? state.defaultTemplate;
  const [text, setText] = useState(baseline);
  const dirty = text !== baseline;
  const max = AGENT_PROMPT_MAX_CHARS[kind];
  const over = text.length - max;

  const save = useMutation({
    mutationFn: (template: string | null) => saveAgentPrompt(kind, template),
    onSuccess: (next) => {
      qc.setQueryData<AgentPromptsResponse>(outreachKeys.agentPrompts, (old) => (old ? { ...old, [kind]: next } : old));
      setText(next.active ?? next.defaultTemplate);
    },
  });
  const preview = useMutation({ mutationFn: (template: string) => previewAgentPrompt(kind, template) });
  const load = useMutation({
    mutationFn: (id: string) => getAgentPromptVersion(kind, id),
    onSuccess: (version) => edit(version.body ?? state.defaultTemplate),
  });

  // The server refuses a text over the limit with its problems, as a save does; shown the way a checked preview's are.
  const previewProblems = preview.error ? promptProblems(preview.error) : null;

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  // A new draft makes the last answers stale: a "Saved" note, a refusal, a preview of other text.
  function edit(next: string): void {
    setText(next);
    if (save.status !== 'idle') save.reset();
    if (preview.status !== 'idle') preview.reset();
  }
  function loadVersion(id: string): void {
    if (dirty && !window.confirm(REPLACE_WORDS)) return;
    load.mutate(id);
  }

  return (
    <div className="space-y-5 pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="text-sm text-muted-foreground">{promptStatusWords(state)}</p>
        {dirty && <StatusBadge tone="warning">Unsaved changes</StatusBadge>}
      </div>
      <div className="space-y-1.5">
        <Textarea
          aria-label={label}
          aria-describedby={countId}
          aria-invalid={over > 0 || undefined}
          value={text}
          readOnly={save.isPending}
          spellCheck={false}
          onChange={(e) => edit(e.target.value)}
          className={cn('resize-y font-mono text-[13px] leading-5', kind === 'instructions' ? 'min-h-[60vh]' : 'min-h-40')}
        />
        <p id={countId} className={cn('text-xs', over > 0 ? 'text-destructive' : 'text-muted-foreground')}>{characterCountWords(text.length, max)}</p>
        {over > 0 && <p className="text-xs text-destructive">{`Too long: shorten it by ${over.toLocaleString('en-US')} characters to save or preview it.`}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => save.mutate(text)} disabled={!dirty || save.isPending || over > 0}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        <Button variant="outline" onClick={() => preview.mutate(text)} disabled={preview.isPending || over > 0}>{preview.isPending ? 'Checking…' : 'Preview'}</Button>
        <ConfirmAction
          label="Reset to default"
          title="Go back to the built-in prompt?"
          description="Your edits stay in Previous versions."
          confirmLabel="Reset to default"
          triggerVariant="outline"
          disabled={save.isPending || (state.active === null && !dirty)}
          onConfirm={() => save.mutate(null)}
        />
      </div>
      {save.error && <SaveFailure error={save.error} />}
      {save.isSuccess && <p role="status" className="text-sm font-medium text-success">{save.variables === null ? RESET_WORDS : SAVED_WORDS}</p>}
      {preview.error && (previewProblems ? <PreviewPanel rendered={null} problems={previewProblems} /> : <p role="alert" className="text-sm text-destructive">{agentPromptErrorText(preview.error)}</p>)}
      {preview.data && <PreviewPanel rendered={preview.data.rendered} problems={preview.data.problems} />}
      <PlaceholderList placeholders={state.placeholders} />
      <VersionList
        versions={state.versions}
        loadingId={load.isPending ? load.variables : null}
        disabled={save.isPending || load.isPending}
        onLoad={loadVersion}
        error={load.error ? versionLoadErrorText(load.error) : null}
      />
    </div>
  );
}
