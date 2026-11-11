import { useRef, useState } from 'react';

type SyncPage = { page: number; limit: number; count: number; synced: number; done: boolean };
type Status = 'idle' | 'running' | 'stopped' | 'failed' | 'complete';

type Progress = { page: number; processed: number; synced: number; total: number };
type Scope = 'all' | 'since';
type SyncOptions = { createdAfter?: string; limit: number };

// must match PAGE_SIZES in functions/lib/algolia.ts; the Worker rejects other values
const PAGE_SIZES = [10, 100, 200, 500, 1000];
const DEFAULT_PAGE_SIZE = 100;

const emptyProgress: Progress = { page: 0, processed: 0, synced: 0, total: 0 };

class SyncError extends Error {
  details: unknown;
  constructor(message: string, details: unknown) {
    super(message);
    this.details = details;
  }
}

// Start of the selected day in the merchant's local time zone, as ISO
function startOfDay(date: string) {
  return new Date(`${date}T00:00:00`).toISOString();
}

async function syncPage(page: number, { createdAfter, limit }: SyncOptions): Promise<SyncPage> {
  const response = await fetch('/app-api/admin/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createdAfter ? { page, limit, created_after: createdAfter } : { page, limit }),
  });
  const text = await response.text();
  let result: Partial<SyncPage> & { error?: string; details?: unknown } = {};
  try { result = JSON.parse(text); } catch { /* not JSON */ }
  if (!response.ok) {
    throw new SyncError(
      result.error || `Sync failed with status ${response.status}`,
      result.details ?? { page, status: response.status, response: text.slice(0, 2000) },
    );
  }
  return result as SyncPage;
}

export default function ProductSync() {
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState<Progress>(emptyProgress);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState<unknown>(null);
  const [stopping, setStopping] = useState(false);
  const [scope, setScope] = useState<Scope>('all');
  const [sinceDate, setSinceDate] = useState('');
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  // options of the current sync, kept for resume even if the form changes (page numbers depend on the size)
  const [activeSync, setActiveSync] = useState<SyncOptions & { label: string }>({ limit: DEFAULT_PAGE_SIZE, label: 'All products' });
  const stopRequested = useRef(false);

  // Sync pages of products one after another, starting from `fromPage`.
  async function run(fromPage: number, initial: Progress, options: SyncOptions) {
    stopRequested.current = false;
    setStopping(false);
    setStatus('running');
    setError('');
    setErrorDetails(null);
    let current = initial;
    let page = fromPage;
    try {
      for (;;) {
        const result = await syncPage(page, options);
        current = {
          page: result.page,
          processed: Math.min(result.count, (result.page - 1) * result.limit + result.synced),
          synced: current.synced + result.synced,
          total: result.count,
        };
        setProgress(current);
        if (result.done) { setStatus('complete'); return; }
        if (stopRequested.current) { setStatus('stopped'); return; }
        page = result.page + 1;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sync products');
      setErrorDetails(err instanceof SyncError ? err.details : String(err));
      setStatus('failed');
    }
  }

  const start = () => {
    const options = scope === 'since' && sinceDate
      ? { createdAfter: startOfDay(sinceDate), limit: pageSize, label: `Products created on or after ${formatDate(sinceDate)}` }
      : { limit: pageSize, label: 'All products' };
    setActiveSync(options);
    setProgress(emptyProgress);
    void run(1, emptyProgress, options);
  };
  const resume = () => void run(progress.page + 1, progress, activeSync);
  const stop = () => { stopRequested.current = true; setStopping(true); };

  const running = status === 'running';
  const canStart = !running && (scope === 'all' || Boolean(sinceDate));
  const canResume = (status === 'stopped' || status === 'failed') && progress.page > 0;
  const percent = status === 'complete' ? 100
    : progress.total ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0;

  return <>
    <section className="card">
      <div className="card-head">
        <h2 id="sync-scope-title">Products to sync</h2>
      </div>
      <div className="card-body">
        <fieldset className="choices" aria-labelledby="sync-scope-title" disabled={running}>
          <label className={scope === 'all' ? 'choice is-on' : 'choice'}>
            <input type="radio" name="scope" value="all" checked={scope === 'all'} onChange={() => setScope('all')} />
            <span className="choice-text"><strong>All products</strong><span>Every active product in the store.</span></span>
          </label>
          <label className={scope === 'since' ? 'choice is-on' : 'choice'}>
            <input type="radio" name="scope" value="since" checked={scope === 'since'} onChange={() => setScope('since')} />
            <span className="choice-text"><strong>Products created on or after</strong><span>From the start of that day, in your time zone.</span></span>
            <input
              type="date"
              value={sinceDate}
              max={new Date().toLocaleDateString('en-CA')}
              aria-label="Created on or after"
              onChange={(event) => { setSinceDate(event.target.value); setScope('since'); }}
            />
          </label>
        </fieldset>
        <div className="setting">
          <div className="setting-text">
            <label htmlFor="page-size">Page size</label>
            <span>Products per request. Larger pages need fewer requests.</span>
          </div>
          <select id="page-size" value={pageSize} disabled={running} onChange={(event) => setPageSize(Number(event.target.value))}>
            {PAGE_SIZES.map((size) => <option key={size} value={size}>{size} products</option>)}
          </select>
        </div>
      </div>
      <div className="card-foot">
        <div className="sync-actions">
          <button type="button" className="primary" onClick={start} disabled={!canStart}>
            {status === 'idle' ? 'Start sync' : 'Start new sync'}
          </button>
          {running && <button type="button" onClick={stop} disabled={stopping}>{stopping ? 'Stopping…' : 'Stop'}</button>}
          {canResume && <button type="button" onClick={resume}>Resume from page {progress.page + 1}</button>}
        </div>
      </div>
    </section>

    {status !== 'idle' && <section className="card sync-progress" aria-label="Sync progress">
      <div className="card-body">
        <div className="progress-head">
          <span className={`badge badge-${status}`}>{statusLabel(status)}</span>
          <span className="progress-label">{activeSync.label}</span>
          <span className="progress-pct">{percent}%</span>
        </div>
        <div
          className={`bar bar-${status}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label="Sync progress"
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        <dl className="stats">
          <div><dt>Processed</dt><dd>{count(progress.processed)} <span>of {count(progress.total)}</span></dd></div>
          <div><dt>Sent to Algolia</dt><dd>{count(progress.synced)}</dd></div>
          <div><dt>Pages done</dt><dd>{count(progress.page)}</dd></div>
        </dl>
        <p role="status" className="visually-hidden">
          {statusLabel(status)} · {activeSync.label} · {progress.processed} of {progress.total} products processed ({percent}%)
          {' '}· {progress.synced} sent to Algolia
        </p>
        {error && <div className="sync-error" role="alert">
          <p>{error}</p>
          {errorDetails != null && <details open>
            <summary>Error details</summary>
            <pre>{JSON.stringify(errorDetails, null, 2)}</pre>
          </details>}
        </div>}
      </div>
    </section>}
  </>;
}

function count(value: number) {
  return value.toLocaleString();
}

// A picked day as the merchant reads it, e.g. Sep 1, 2026
function formatDate(date: string) {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function statusLabel(status: Status) {
  switch (status) {
    case 'running': return 'Syncing';
    case 'stopped': return 'Stopped';
    case 'failed': return 'Failed';
    case 'complete': return 'Complete';
    default: return '';
  }
}
