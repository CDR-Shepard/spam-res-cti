import { useEffect, useState } from 'react';
import { api } from './api';
import { RecentCalls } from './components/RecentCalls';
import { ReputationPanel } from './components/ReputationPanel';
import { ClockIcon, GridIcon, MinusIcon, SettingsIcon, ShieldIcon, XIcon } from './icons';
import { AppProvider, useApp } from './state';
import { DialerView } from './views/DialerView';
import { SettingsView } from './views/SettingsView';
import { SignInView } from './views/SignInView';

type Tab = 'dialer' | 'recent' | 'reputation' | 'settings';

interface RepSummary {
  avgComposite: number;
  avgGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  flaggedCount: number;
}

function Header({ onRepChip }: { onRepChip: () => void }): JSX.Element {
  const { me, session, customDisplayName } = useApp();
  const [rep, setRep] = useState<RepSummary | null>(null);

  // Live org reputation grade — best-effort, refreshed every minute.
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const r = await api<{ summary: RepSummary }>('/reputation');
        if (alive) setRep(r.summary);
      } catch { /* chip is optional */ }
    };
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const sf = me?.salesforce.connected === true ? me.salesforce : null;
  // Priority: SF profile > user-set custom name > a generic fallback.
  // We deliberately do NOT fall back to the dev session email, since that's
  // always "dev@example.com" in the MVP build.
  const isDevSession = session.email === 'dev@example.com';
  const sessionPrefix = !isDevSession ? session.email?.split('@')[0] : null;
  const displayName = sf?.name?.trim() || customDisplayName || sessionPrefix || 'Sales Rep';
  const initials = displayName
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || 'DR';
  const photo = sf?.photoDataUrl ?? null;
  return (
    <div className="header">
      <div className="left">
        {photo ? (
          <img src={photo} alt={displayName} className="avatar photo" />
        ) : (
          <div className="avatar">{initials}</div>
        )}
        <div className="identity">
          <div className="name">{displayName}</div>
          <div className="status">
            <span className={`presence-dot ${sf ? '' : 'warn'}`} />
            {sf ? 'Connected to Salesforce' : 'Salesforce off'}
          </div>
        </div>
      </div>
      <div className="right">
        {rep && (
          <button
            className={`rep-chip grade-${rep.avgGrade.toLowerCase()} ${rep.flaggedCount > 0 ? 'flagged' : ''}`}
            title={`Caller reputation ${rep.avgComposite}/100${rep.flaggedCount > 0 ? ` · ${rep.flaggedCount} flagged` : ''}`}
            onClick={onRepChip}
          >
            <ShieldIcon />
            <span>{rep.avgGrade}</span>
          </button>
        )}
        <button className="iconbtn" title="Hide" onClick={() => void window.cti.hideWindow()}>
          <MinusIcon />
        </button>
        <button className="iconbtn" title="Quit" onClick={() => void window.cti.quit()}>
          <XIcon />
        </button>
      </div>
    </div>
  );
}

function Nav(props: { tab: Tab; setTab: (t: Tab) => void }): JSX.Element {
  const items: Array<{ id: Tab; label: string; icon: JSX.Element }> = [
    { id: 'dialer', label: 'Dial', icon: <GridIcon /> },
    { id: 'recent', label: 'Recent', icon: <ClockIcon /> },
    { id: 'reputation', label: 'Reputation', icon: <ShieldIcon /> },
    { id: 'settings', label: 'Settings', icon: <SettingsIcon /> },
  ];
  return (
    <div className="nav">
      {items.map((i) => (
        <button
          key={i.id}
          className={`tab ${props.tab === i.id ? 'active' : ''}`}
          onClick={() => props.setTab(i.id)}
        >
          {i.icon}
          <span>{i.label}</span>
        </button>
      ))}
    </div>
  );
}

function Shell(): JSX.Element {
  const { ready, session, toast, incomingTel } = useApp();
  const [tab, setTab] = useState<Tab>('dialer');

  // Any tel: URL → snap to dialer tab so the user sees the prefilled number.
  useEffect(() => {
    if (incomingTel) setTab('dialer');
  }, [incomingTel]);

  if (!ready) {
    return (
      <div className="app">
        <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
          <span className="spinner lg" />
        </div>
      </div>
    );
  }

  if (!session.token) {
    return (
      <div className="app">
        <SignInView />
      </div>
    );
  }

  return (
    <div className="app">
      <Header onRepChip={() => setTab('reputation')} />
      <div className="body">
        {tab === 'dialer' && <DialerView />}
        {tab === 'recent' && <RecentCalls />}
        {tab === 'reputation' && <ReputationPanel />}
        {tab === 'settings' && <SettingsView />}
      </div>
      <Nav tab={tab} setTab={setTab} />
      {toast && <div className={`toast ${toast.type}`}>{toast.text}</div>}
    </div>
  );
}

export function App(): JSX.Element {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
