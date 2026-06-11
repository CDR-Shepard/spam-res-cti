import { useState } from 'react';
import { useApp } from '../state';
import { PhoneIcon } from '../icons';

export function SignInView(): JSX.Element {
  const { signInDev } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="signin">
      <div className="logo"><PhoneIcon /></div>
      <h2>Caller Reputation CTI</h2>
      <p>Sign in as the seeded dev rep.<br/>Replace with SSO before production use.</p>
      <button
        className="btn primary full"
        disabled={busy}
        onClick={async () => {
          setBusy(true); setErr(null);
          try { await signInDev(); }
          catch (e) { setErr((e as Error).message); }
          finally { setBusy(false); }
        }}
      >
        {busy ? <><span className="spinner" /> Signing in…</> : 'Sign in'}
      </button>
      {err && <p style={{ color: 'var(--bad)', marginTop: 12, fontSize: 12 }}>{err}</p>}
    </div>
  );
}
