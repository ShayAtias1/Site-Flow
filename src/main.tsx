import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/heebo/400.css';
import '@fontsource/heebo/500.css';
import '@fontsource/heebo/600.css';
import '@fontsource/heebo/700.css';
import { App } from './App';
import '../design/siteflow-tokens.css';
import './styles.css';
import { setToken } from './api';

// A server started with an access code (e.g. a temporary tunnel for a phone) is opened once as
// …/?access=<code>. The code is kept on this device and removed from the address bar at once.
try {
  const url = new URL(location.href);
  const code = url.searchParams.get('access');
  if (code) {
    setToken(code);
    url.searchParams.delete('access');
    history.replaceState(null, '', url.toString());
  }
} catch {
  /* no access code */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
