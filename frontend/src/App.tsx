import ProductSync from './ProductSync';
import './App.css';

export default function App() {
  return <main>
    <h1>Algolia product sync</h1>
    <p>Push active products to your Algolia index page by page: all of them, or only those created on or after a date you choose. Keep this page open until the sync completes.</p>
    <ProductSync />
  </main>;
}
