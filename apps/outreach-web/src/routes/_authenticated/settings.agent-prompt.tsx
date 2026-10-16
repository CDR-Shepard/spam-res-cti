import { createFileRoute } from '@tanstack/react-router';
import { AgentPromptPage } from '@/components/agent-prompt-page';

// Agent prompt (admins): the AI phone agent's call instructions and voicemail message. The page shows non-admins a not-allowed line.
export const Route = createFileRoute('/_authenticated/settings/agent-prompt')({ component: AgentPromptPage });
