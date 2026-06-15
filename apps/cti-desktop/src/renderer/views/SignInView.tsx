import { useState } from 'react';
import { useApp } from '../state';
import { PhoneIcon } from '../icons';

export function SignInView(): JSX.Element {
  const { signInDev, signInWithSalesforce } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isDev = import.meta.env.DEV;
  return (
    <div className="signin">
      <div className="logo"><PhoneIcon /></div>
      <h2>Caller Reputation CTI</h2>
      <p>Sign in with your Salesforce account to start calling.</p>
      <button
        className="btn primary full"
        disabled={busy}
        onClick={async () => {
          setBusy(true); setErr(null);
          try { await signInWithSalesforce(); }
          catch (e) { setErr((e as Error).message); }
          finally { setBusy(false); }
        }}
      >
        {busy ? <><span className="spinner" /> Signing in…</> : 'Sign in with Salesforce'}
      </button>
      {isDev && (
        <button
          className="btn ghost full"
          style={{ marginTop: 8 }}
          disabled={busy}
          onClick={async () => {
            setBusy(true); setErr(null);
            try { await signInDev(); }
            catch (e) { setErr((e as Error).message); }
            finally { setBusy(false); }
          }}
        >
          Dev sign-in
        </button>
      )}
      {err && <p style={{ color: 'var(--bad)', marginTop: 12, fontSize: 12 }}>{err}</p>}
    </div>
  );
}
