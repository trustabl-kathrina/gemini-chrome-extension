import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from '@/src/ui/App';
import '@/src/ui/styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
