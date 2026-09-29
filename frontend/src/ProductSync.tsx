import { useRef, useState } from 'react';

type SyncPage = { page: number; limit: number; count: number; synced: number; done: boolean };
type Status = 'idle' | 'running' | 'stopped' | 'failed' | 'complete';

type Progress = { page: number; processed: number; synced: number; total: number };
type Scope = 'all' | 'since';

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

async function syncPage(page: number, createdAfter?: string): Promise<SyncPage> {
  const response = await fetch('/app-api/admin/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createdAfter ? { page, created_after: createdAfter } : { page }),
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
  const [activeFilter, setActiveFilter] = useState<{ createdAfter?: string; label: string }>({ label: 'all products' });
  const stopRequested = useRef(false);

  // Sync pages of 100 products one after another, starting from `fromPage`.
  async function run(fromPage: number, initial: Progress, createdAfter?: string) {
    stopRequested.current = false;
    setStopping(false);
    setStatus('running');
    setError('');
    setErrorDetails(null);
    let current = initial;
    let page = fromPage;
    try {
      for (;;) {
        const result = await syncPage(page, createdAfter);
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
    const filter = scope === 'since' && sinceDate
      ? { createdAfter: startOfDay(sinceDate), label: `products created on or after ${sinceDate}` }
      : { label: 'all products' };
    setActiveFilter(filter);
    setProgress(emptyProgress);
    void run(1, emptyProgress, filter.createdAfter);
  };
  const resume = () => void run(progress.page + 1, progress, activeFilter.createdAfter);
  const stop = () => { stopRequested.current = true; setStopping(true); };

  const running = status === 'running';
  const canStart = !running && (scope === 'all' || Boolean(sinceDate));
  const canResume = (status === 'stopped' || status === 'failed') && progress.page > 0;
  const percent = status === 'complete' ? 100
    : progress.total ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0;

  return <section className="sync">
    <fieldset className="sync-scope" disabled={running}>
      <legend>Products to sync</legend>
      <label>
        <input type="radio" name="scope" value="all" checked={scope === 'all'} onChange={() => setScope('all')} />
        All products
      </label>
      <label>
        <input type="radio" name="scope" value="since" checked={scope === 'since'} onChange={() => setScope('since')} />
        Products created on or after
        <input
          type="date"
          value={sinceDate}
          max={new Date().toLocaleDateString('en-CA')}
          aria-label="Created on or after"
          onChange={(event) => { setSinceDate(event.target.value); setScope('since'); }}
        />
      </label>
    </fieldset>

    <div className="sync-actions">
      <button type="button" className="primary" onClick={start} disabled={!canStart}>
        {status === 'idle' ? 'Start sync' : 'Start new sync'}
      </button>
      {running && <button type="button" onClick={stop} disabled={stopping}>{stopping ? 'Stopping…' : 'Stop'}</button>}
      {canResume && <button type="button" onClick={resume}>Resume from page {progress.page + 1}</button>}
    </div>

    {status !== 'idle' && <div className="sync-progress">
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
      <p role="status">
        {statusLabel(status)} · {activeFilter.label} · {progress.processed} of {progress.total} products processed ({percent}%)
        {progress.page > 0 && <> · page {progress.page}</>}
        {' '}· {progress.synced} sent to Algolia
      </p>
      {error && <div className="sync-error" role="alert">
        <p>{error}</p>
        {errorDetails != null && <details open>
          <summary>Error details</summary>
          <pre>{JSON.stringify(errorDetails, null, 2)}</pre>
        </details>}
      </div>}
    </div>}
  </section>;
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
