import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Show the dashboard's theme. The dashboard sends it to its frame
// (swell:theme) on load, when it changes and when asked; until then, follow
// the color scheme the frame was given.
const root = document.documentElement;
root.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
window.addEventListener('message', (event) => {
  if (event.source === window.parent && event.data?.type === 'swell:theme') {
    root.dataset.theme = event.data.scheme === 'dark' ? 'dark' : 'light';
  }
});
if (window.parent !== window) window.parent.postMessage({ type: 'swell:theme:get' }, '*');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
