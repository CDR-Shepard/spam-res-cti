import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AgentPromptKind } from '@cti/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { agentPromptErrorText } from '@/lib/agent-prompt-words';
import { useAuth } from '@/lib/auth';
import { getAgentPrompts, outreachKeys } from '@/lib/outreach-api';
import { KIND_LABELS, PromptEditor } from './agent-prompt-editor';
import { LeaveGuard } from './record-test-leave-guard';

const KINDS = AgentPromptKind.options;
export const LEAVE_UNSAVED_WORDS = 'You have unsaved changes to this prompt. Leave without saving?';
const SWITCH_UNSAVED_WORDS = 'You have unsaved changes to this prompt. Switch without saving?';

/**
 * Agent prompt (admins): edit, preview, save and reset the AI phone agent's call instructions, its voicemail message and the
 * instructions it follows when a test phone calls it. `initialKind` is the tab it opens on. A saved change applies from the next call. Leaving the page, a reload, or switching tabs with unsaved edits asks first.
 */
export function AgentPromptPage({ initialKind }: { initialKind?: AgentPromptKind }) {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  if (!isAdmin) return <p className="text-sm text-muted-foreground">Only admins can edit the agent prompt.</p>;
  return <AdminAgentPromptPage initialKind={initialKind ?? 'instructions'} />;
}

function AdminAgentPromptPage({ initialKind }: { initialKind: AgentPromptKind }) {
  // Not refetched on focus or reconnect: the editors' text starts from this, and a silent change under an edit would read as unsaved edits.
  const prompts = useQuery({ queryKey: outreachKeys.agentPrompts, queryFn: getAgentPrompts, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const [kind, setKind] = useState<AgentPromptKind>(initialKind);
  const [dirty, setDirty] = useState(false);

  const pick = (value: string): void => {
    const next = AgentPromptKind.safeParse(value);
    if (!next.success || next.data === kind) return;
    if (dirty && !window.confirm(SWITCH_UNSAVED_WORDS)) return;
    setDirty(false);
    setKind(next.data);
  };

  return (
    <div className="space-y-6">
      {dirty && <LeaveGuard words={LEAVE_UNSAVED_WORDS} />}
      <PageHeader
        title="Agent prompt"
        description="The instructions the AI phone agent follows on every call, the voicemail it leaves, and what it follows when a test phone calls it. A saved change applies from the next call."
      />
      {prompts.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {prompts.error && <p role="alert" className="text-sm text-destructive">{agentPromptErrorText(prompts.error)}</p>}
      {prompts.data && (
        // Manual: a tab is chosen by clicking it or pressing Enter, not by focusing it, so a cancelled switch never asks twice.
        <Tabs value={kind} onValueChange={pick} activationMode="manual">
          <TabsList aria-label="Which text to edit">
            {KINDS.map((k) => <TabsTrigger key={k} value={k}>{KIND_LABELS[k]}</TabsTrigger>)}
          </TabsList>
          {KINDS.map((k) => (
            <TabsContent key={k} value={k}>
              <PromptEditor kind={k} state={prompts.data[k]} onDirtyChange={setDirty} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
