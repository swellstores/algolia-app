import ProductSync from './ProductSync';
import './App.css';

function AlgoliaMark() {
  return <svg viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id="algolia-mark" gradientUnits="userSpaceOnUse" x1="-23.699" y1="85.935" x2="82.938" y2="-17.337">
        <stop offset="0" stopColor="#00aeff" /><stop offset="1" stopColor="#3369e7" />
      </linearGradient>
    </defs>
    <path d="M8.6.2h46.8c4.6 0 8.4 3.7 8.4 8.4v46.8c0 4.6-3.7 8.4-8.4 8.4H8.6C4 63.8.2 60.1.2 55.4V8.6C.3 4 4 .2 8.6.2z" fill="url(#algolia-mark)" />
    <path fill="#fff" d="M32.7 16.3c-9.9 0-17.9 8-17.9 18s8 17.9 17.9 17.9 17.9-8 17.9-18-7.9-17.9-17.9-17.9zm0 30.6c-7 0-12.6-5.7-12.6-12.6s5.7-12.6 12.6-12.6 12.6 5.7 12.6 12.6-5.6 12.6-12.6 12.6zm0-22.7v9.4c0 .3.3.5.5.3l8.4-4.3c.2-.1.3-.3.2-.5-1.7-3-4.9-5.1-8.7-5.3-.2 0-.4.2-.4.4zM21 17.3l-1.1-1.1c-1.1-1.1-2.8-1.1-3.9 0l-1.3 1.3c-1.1 1.1-1.1 2.8 0 3.9l1.1 1.1c.2.2.4.1.6 0 .6-.9 1.3-1.7 2.1-2.5s1.6-1.5 2.5-2.1c.2-.2.2-.5 0-.6zm17.6-2.9v-2.2c0-1.5-1.2-2.8-2.8-2.8h-6.4c-1.5 0-2.8 1.2-2.8 2.8v2.2c0 .3.2.4.5.4 1.8-.5 3.7-.8 5.6-.8 1.8 0 3.6.3 5.4.7.3.1.5 0 .5-.3z" />
  </svg>;
}

export default function App() {
  return <main>
    <header className="page-head">
      <span className="page-icon"><AlgoliaMark /></span>
      <div>
        <h1>Algolia product sync</h1>
        <p>Push active products to your Algolia index page by page: all of them, or only those created on or after a date you choose. Keep this page open until the sync completes.</p>
      </div>
    </header>
    <ProductSync />
  </main>;
}
