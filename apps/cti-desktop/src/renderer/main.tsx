import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Apply the saved theme as early as possible — before React paints — to avoid
// a dark→light flash on launch when the user has chosen light.
try {
  const t = localStorage.getItem('cti.theme');
  // Default to light unless the user has explicitly chosen dark.
  document.documentElement.dataset.theme = t === 'dark' ? 'dark' : 'light';
} catch { /* localStorage unavailable, default to light */ }

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
