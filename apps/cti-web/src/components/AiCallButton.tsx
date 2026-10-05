import { useState } from 'react';
import { aiCallErrorMessage, startAiCall, type AiCallTarget } from '../ai-calls-api';

interface AiCallButtonProps {
  /** The click-to-dial record (see aiCallTargetFor), or null for none. */
  target: AiCallTarget | null;
  /** GET /ai-calls/availability said AI calling is on. */
  available: boolean;
  recordName?: string;
  /** A human call is being placed — don't start an AI call on top of it. */
  disabled?: boolean;
  /** POST /ai-calls answered 201. */
  onStarted: (aiCallId: string) => void;
}

/**
 * "AI call" beside the normal call action, for a Lead / Opportunity / Contact
 * that came from click-to-dial. Pressing it asks the server to have the AI
 * assistant call the record; every safety check runs there, and a refusal is
 * shown here in plain words.
 */
export function AiCallButton({ target, available, recordName, disabled, onStarted }: AiCallButtonProps): JSX.Element | null {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!available || !target) return null;

  const start = async (): Promise<void> => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const res = await startAiCall(target);
      onStarted(res.aiCallId);
    } catch (err) {
      setError(aiCallErrorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="ai-call-row">
      <div className="ai-call-row-main">
        <div className="ai-call-row-text">
          Let the AI assistant call {recordName ? <strong>{recordName}</strong> : `this ${target.objectType.toLowerCase()}`}
        </div>
        <button className="btn primary" onClick={() => void start()} disabled={starting || disabled}>
          {starting ? <><span className="spinner" /> Starting…</> : 'AI call'}
        </button>
      </div>
      {error && <div className="ai-call-error" role="alert">{error}</div>}
    </div>
  );
}
