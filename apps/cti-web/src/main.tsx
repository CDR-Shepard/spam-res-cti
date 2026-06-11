import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Iframe softphone is locked to light — the menubar app owns the theme
// toggle. (Forcing this here so the in-Salesforce panel stays clean regardless
// of what was stored at this origin previously.)
document.documentElement.dataset.theme = 'light';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
