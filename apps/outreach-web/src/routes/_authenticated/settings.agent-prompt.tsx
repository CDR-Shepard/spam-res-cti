import { createFileRoute } from '@tanstack/react-router';
import { AgentPromptPage } from '@/components/agent-prompt-page';
import { agentPromptSearch } from '@/lib/agent-prompt-words';

// Agent prompt (admins): the AI phone agent's call instructions, voicemail message and inbound-call instructions. The page shows
// non-admins a not-allowed line. `?tab=inbound` (or voicemail) opens on that tab.
export const Route = createFileRoute('/_authenticated/settings/agent-prompt')({ component: AgentPromptRoute, validateSearch: agentPromptSearch });

function AgentPromptRoute() {
  // Validated again here: the root route has no validator, so a raw `?tab=` would otherwise pass through to this match.
  const { tab } = agentPromptSearch(Route.useSearch());
  return <AgentPromptPage initialKind={tab} />;
}
