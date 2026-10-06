import { useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { Activity, ArrowUpRight, BookOpen, Clock3, Copy, FileLock2, GitBranch, Radio, RefreshCw, ShieldCheck, Terminal, Unlock, Zap } from 'lucide-react';
import {
  useAcquireLocks, useCreateActivityLog, useGetActiveLocks, useGetDashboardSummary,
  useGetTodayActivity, useReleaseLocks, getGetActiveLocksQueryKey,
  getGetDashboardSummaryQueryKey, getGetTodayActivityQueryKey,
} from '@workspace/api-client-react';
import NotFound from '@/pages/not-found';

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 2500, retry: 1 } } });
const POLL_MS = 6000;
const pathsFrom = (value: string) => value.split(/[\n,]+/).map((path) => path.trim()).filter(Boolean);
const clock = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const expiry = (value: string) => {
  const milliseconds = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(milliseconds)) return 'expiry unavailable';
  if (milliseconds <= 0) return 'expires shortly';
  const minutes = Math.ceil(milliseconds / 60000);
  return `expires in ${minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`}`;
};

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <div className="shell">
    <aside className="rail">
      <div className="brand"><div className="brand-mark"><GitBranch size={19} /></div><div><div className="brand-title">Coordination Hub</div><div className="brand-sub">SHARED WORKSPACE / 01</div></div></div>
      <div className="rail-label">Control surface</div>
      <nav aria-label="Main navigation">
        <Link href="/" data-testid="link-dashboard" className={`rail-link ${location === '/' ? 'active' : ''}`}><Activity size={16} />Live activity</Link>
        <Link href="/docs" data-testid="link-docs" className={`rail-link ${location === '/docs' ? 'active' : ''}`}><BookOpen size={16} />Worker API</Link>
      </nav>
      <div className="rail-bottom"><div className="rail-status"><span className="status-dot" />Shared state connected</div><div className="rail-caption">Independent agents. One coordinated workspace. Path locks prevent overlapping edits.</div></div>
    </aside>
    <main className="main">{children}</main>
  </div>;
}

function TopLine() {
  return <div className="topline"><div className="eyebrow">Coordination / Shared state</div><div className="live-chip"><span className="status-dot" />Signals live <span>·</span> polling every 6s</div></div>;
}

function Metric({ label, value, note, warn, id }: { label: string; value?: number; note: string; warn?: boolean; id: string }) {
  return <div className={`metric ${warn ? 'warn' : ''}`} data-testid={id}><div className="metric-label">{label}</div>{value === undefined ? <div className="metric-value load-line" /> : <div className="metric-value" data-testid={`${id}-value`}>{value}</div>}<div className="metric-foot">{note}</div></div>;
}

function QueryError({ message, retry }: { message: string; retry: () => void }) {
  return <div className="error-state"><div><strong>Could not reach shared state</strong><br />{message}<br /><button className="retry" onClick={retry} data-testid="button-retry">Retry connection</button></div></div>;
}

function Dashboard() {
  const queryClient = useQueryClient();
  const activity = useGetTodayActivity({ query: { queryKey: getGetTodayActivityQueryKey(), refetchInterval: POLL_MS } });
  const locks = useGetActiveLocks({ query: { queryKey: getGetActiveLocksQueryKey(), refetchInterval: POLL_MS } });
  const summary = useGetDashboardSummary({ query: { queryKey: getGetDashboardSummaryQueryKey(), refetchInterval: POLL_MS } });
  const createLog = useCreateActivityLog();
  const acquire = useAcquireLocks();
  const release = useReleaseLocks();
  const [activityNotice, setActivityNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [lockNotice, setLockNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [updated, setUpdated] = useState(() => new Date());
  const refresh = () => { void activity.refetch(); void locks.refetch(); void summary.refetch(); setUpdated(new Date()); };
  const submitActivity = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const agent_id = String(form.get('agent_id') ?? '').trim();
    const task_description = String(form.get('task_description') ?? '').trim();
    const target_files = pathsFrom(String(form.get('target_files') ?? ''));
    setActivityNotice(null);
    createLog.mutate({ data: { agent_id, task_description, target_files, status: 'working' } }, {
      onSuccess: () => {
        setActivityNotice({ ok: true, text: 'Check-in recorded. The shared timeline is up to date.' });
        formElement.reset();
        void queryClient.invalidateQueries({ queryKey: getGetTodayActivityQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
      onError: (error) => setActivityNotice({ ok: false, text: error instanceof Error ? error.message : 'The check-in could not be recorded.' }),
    });
  };
  const submitLocks = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const agent_id = String(form.get('agent_id') ?? '').trim();
    const target_files = pathsFrom(String(form.get('target_files') ?? ''));
    setLockNotice(null);
    acquire.mutate({ data: { agent_id, target_files } }, {
      onSuccess: (result) => {
        if (result.granted) {
          setLockNotice({ ok: true, text: `${result.locks.length} path ${result.locks.length === 1 ? 'lock' : 'locks'} acquired. Locks expire after two hours.` });
          formElement.reset();
          void queryClient.invalidateQueries({ queryKey: getGetActiveLocksQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        } else {
          const conflicts = (result as typeof result & { conflicts?: { locked_path: string }[] }).conflicts ?? [];
          setLockNotice({ ok: false, text: conflicts.length ? `Paths already held: ${conflicts.map((item) => item.locked_path).join(', ')}` : 'The requested path locks were not granted.' });
        }
      },
      onError: (error) => {
        const conflicts = (error as { data?: { conflicts?: { locked_path: string; agent_id: string }[] } }).data?.conflicts;
        const message = conflicts?.length
          ? `Paths already held: ${conflicts.map((item) => `${item.locked_path} by ${item.agent_id}`).join(', ')}`
          : error instanceof Error ? error.message : 'Could not acquire these paths.';
        setLockNotice({ ok: false, text: message });
      },
    });
  };
  const releasePath = (agent_id: string, path: string) => {
    setLockNotice(null);
    release.mutate({ data: { agent_id, target_files: [path] } }, {
      onSuccess: (result) => {
        setLockNotice({ ok: true, text: `${result.released_count} lock${result.released_count === 1 ? '' : 's'} released.` });
        void queryClient.invalidateQueries({ queryKey: getGetActiveLocksQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
      onError: (error) => setLockNotice({ ok: false, text: error instanceof Error ? error.message : 'Could not release this path.' }),
    });
  };
  const anyQueryError = [activity, locks, summary].find((query) => query.isError);
  const activityItems = activity.data ?? [];
  const lockItems = locks.data ?? [];
  const metrics = summary.data;

  return <>
    <TopLine />
    <header className="page-heading">
      <div><div className="eyebrow">Today's coordination pulse</div><h1>Keep the work<br /> moving together.</h1><p>One live view of agent activity, shared paths, and the work in motion.</p></div>
      <div className="stamp">LOCAL CONTROL / SHARED STATE<br />UPDATED {updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}<br /><button className="text-button" onClick={refresh} data-testid="button-refresh"><RefreshCw size={11} style={{ verticalAlign: '-2px', marginRight: 4 }} />Refresh now</button></div>
    </header>
    <section className="metrics" aria-label="Coordination metrics">
      <Metric label="Active agents" value={metrics?.active_agents} note="agents checked in now" id="metric-active-agents" />
      <Metric label="Held paths" value={metrics?.active_locks} note="workspace paths guarded" id="metric-active-locks" />
      <Metric label="Conflicts today" value={metrics?.conflicts_today} note="overlapping lock requests" warn={!!metrics?.conflicts_today} id="metric-conflicts" />
      <Metric label="Activity today" value={metrics?.activity_today} note="shared work signals" id="metric-activity" />
    </section>
    {anyQueryError && <div className="notice error" role="alert">A live feed is unavailable: {anyQueryError.error instanceof Error ? anyQueryError.error.message : 'Connection error'} <button className="retry" onClick={refresh}>Retry all feeds</button></div>}
    <div className="workspace-grid">
      <section className="panel" aria-labelledby="timeline-heading">
        <div className="panel-head"><div className="panel-title"><Radio size={16} /><span id="timeline-heading">Shared activity</span></div><div className="panel-kicker">{activity.isFetching ? 'SYNCING' : 'TODAY'} / {activity.data?.length ?? '—'} SIGNALS</div></div>
        {activity.isLoading ? <div className="loading-state"><div><div className="load-line" /><div className="load-line" /><div className="load-line" /></div></div>
          : activity.isError ? <QueryError message="The activity feed did not respond." retry={() => void activity.refetch()} />
            : activityItems.length === 0 ? <div className="empty-state"><div><div className="empty-icon"><Activity size={16} /></div><strong>No activity has been shared yet</strong>Worker check-ins will appear here as they arrive.</div></div>
              : <div className="timeline" data-testid="activity-timeline">{activityItems.map((item) => <article className="activity-row" key={item.id} data-testid={`activity-row-${item.id}`}>
                <time className="activity-time">{clock(item.created_at)}</time><div className="timeline-track"><span className="timeline-point" /></div>
                <div className="activity-copy"><div className="activity-top"><span className="agent-tag">{item.agent_id}</span><span className="activity-status">{item.status}</span></div><div className="activity-desc">{item.task_description}</div>
                  <div className="file-list">{item.target_files?.length ? item.target_files.map((file, index) => <span className="file-pill" key={`${file}-${index}`}>{file}</span>) : <span className="file-pill">No paths specified</span>}</div>
                </div>
              </article>)}</div>}
      </section>
      <div className="side-stack">
        <section className="panel" aria-labelledby="locks-heading">
          <div className="panel-head"><div className="panel-title"><FileLock2 size={16} /><span id="locks-heading">Active path locks</span></div><span className="panel-kicker">{lockItems.length} HELD</span></div>
          {locks.isLoading ? <div className="loading-state"><div><div className="load-line" /><div className="load-line" /></div></div>
            : locks.isError ? <QueryError message="The lock registry did not respond." retry={() => void locks.refetch()} />
              : lockItems.length === 0 ? <div className="empty-state"><div><div className="empty-icon"><ShieldCheck size={16} /></div><strong>No active path locks</strong>Agents can acquire paths when work begins.</div></div>
                : <div className="locks-list" data-testid="active-lock-list">{lockItems.map((lock) => <div className="lock-item" key={lock.id} data-testid={`lock-row-${lock.id}`}>
                  <div className="lock-path">{lock.path}</div><div className="lock-meta"><span className="lock-owner">{lock.agent_id}</span><span>{expiry(lock.expires_at)}</span></div>
                  <button className="text-button" disabled={release.isPending} onClick={() => releasePath(lock.agent_id, lock.path)} data-testid={`button-release-lock-${lock.id}`}><Unlock size={11} style={{ verticalAlign: '-2px', marginRight: 4 }} />Release path</button>
                </div>)}</div>}
          <div className="panel-footer"><span className="panel-kicker"><Clock3 size={11} style={{ verticalAlign: '-2px', marginRight: 5 }} />Automatic expiry after two hours</span></div>
        </section>
        <section className="panel"><div className="panel-head"><div className="panel-title"><Zap size={15} /><span>Coordination signal</span></div></div>
          <div className="locks-list"><div style={{ color: '#62756a', fontSize: 11, lineHeight: 1.7 }}>Locks reserve a path and its nested paths atomically. Workers should check in, acquire before editing, then report completion and release.</div></div>
          <div className="panel-footer"><Link href="/docs" className="text-button" data-testid="link-api-guide">Read worker API guide <ArrowUpRight size={12} style={{ verticalAlign: '-2px' }} /></Link></div>
        </section>
      </div>
    </div>
    <div className="action-grid">
      <section className="panel form-panel"><div className="panel-title"><Activity size={15} />Record agent check-in</div><p className="form-intro">Publish a work signal to the shared timeline. Workers can use this to announce a task or completion.</p>
        <form onSubmit={submitActivity} data-testid="form-checkin">
          <div className="field-row"><div className="field"><label htmlFor="activity-agent">AGENT ID</label><input id="activity-agent" name="agent_id" placeholder="worker-alpha" required data-testid="input-activity-agent" /></div><div className="field"><label htmlFor="activity-status">SIGNAL</label><input id="activity-status" value="working" readOnly aria-label="Signal status" /></div></div>
          <div className="field"><label htmlFor="activity-task">TASK DESCRIPTION</label><input id="activity-task" name="task_description" placeholder="Refactor the session boundary" required data-testid="input-activity-task" /></div>
          <div className="field"><label htmlFor="activity-files">TARGET PATHS <span style={{ color: '#92998f' }}>/ optional, one per line or comma</span></label><textarea id="activity-files" name="target_files" placeholder={'src/session.ts\nsrc/session.test.ts'} data-testid="input-activity-files" /></div>
          {activityNotice && <div className={`notice ${activityNotice.ok ? 'success' : 'error'}`} role="status" data-testid="status-checkin">{activityNotice.text}</div>}
          <button className="button" type="submit" disabled={createLog.isPending} data-testid="button-submit-checkin">{createLog.isPending ? 'Publishing signal…' : 'Publish check-in'} <ArrowUpRight size={13} /></button>
        </form>
      </section>
      <section className="panel form-panel"><div className="panel-title"><FileLock2 size={15} />Reserve workspace paths</div><p className="form-intro">Acquire paths as one operation. Overlapping parent or child paths held by another agent will be rejected.</p>
        <form onSubmit={submitLocks} data-testid="form-acquire-locks">
          <div className="field"><label htmlFor="lock-agent">AGENT ID</label><input id="lock-agent" name="agent_id" placeholder="worker-alpha" required data-testid="input-lock-agent" /></div>
          <div className="field"><label htmlFor="lock-paths">TARGET PATHS <span style={{ color: '#92998f' }}>/ one per line or comma</span></label><textarea id="lock-paths" name="target_files" placeholder={'packages/core/src/index.ts\npackages/core/test/index.test.ts'} required data-testid="input-lock-paths" /></div>
          {lockNotice && <div className={`notice ${lockNotice.ok ? 'success' : 'error'}`} role="status" data-testid="status-lock-action">{lockNotice.text}</div>}
          <button className="button" type="submit" disabled={acquire.isPending} data-testid="button-acquire-locks">{acquire.isPending ? 'Requesting paths…' : 'Acquire path locks'} <FileLock2 size={13} /></button>
        </form>
      </section>
    </div>
  </>;
}

const snippets = [
  { id: 'check-in', title: '01 / Check in with the shared timeline', description: 'Publish the current task before starting work so neighboring agents can see intent. Include touched paths when known.', endpoint: 'POST /api/v1/log', code: `curl -X POST "$HUB_URL/api/v1/log" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "worker-alpha",
    "task_description": "Update session renewal",
    "target_files": ["src/session.ts"],
    "status": "working"
  }'` },
  { id: 'locking', title: '02 / Reserve paths before editing', description: 'Acquisition is atomic. Parent and child paths overlap; a conflicting request is denied with the existing owner and expiry. Granted locks expire automatically after two hours.', endpoint: 'POST /api/v1/locks/acquire', code: `curl -X POST "$HUB_URL/api/v1/locks/acquire" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "worker-alpha",
    "target_files": ["src/session.ts", "src/session.test.ts"]
  }'` },
  { id: 'completion', title: '03 / Announce completion and release', description: 'Record a completion signal, then release paths. Omit target_files to release every lock held by this agent.', endpoint: 'POST /api/v1/locks/release', code: `curl -X POST "$HUB_URL/api/v1/locks/release" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "worker-alpha",
    "target_files": ["src/session.ts", "src/session.test.ts"]
  }'

# Then report the completed work
curl -X POST "$HUB_URL/api/v1/log" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "worker-alpha",
    "task_description": "Session renewal updated",
    "target_files": ["src/session.ts"],
    "status": "completed"
  }'` },
];

function Docs() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (id: string, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(id);
      window.setTimeout(() => setCopied((value) => value === id ? null : value), 1800);
    } catch {
      setCopied(`error-${id}`);
      window.setTimeout(() => setCopied(null), 2200);
    }
  };
  return <>
    <TopLine />
    <header className="page-heading"><div><div className="eyebrow">Integration notes / v1</div><h1>Worker API guide</h1><p>Three signals are enough to coordinate independent work.</p></div><div className="stamp">SHARED CONTRACT<br />HTTP / JSON</div></header>
    <div className="docs-content">
      <p className="docs-lede">The coordination service is a shared source of truth for agent presence and filesystem path ownership. Check in, reserve paths before writing, and release them when the work is done.</p>
      <div className="docs-callout"><ShieldCheck size={17} /><div><strong>Set your endpoint once.</strong> Configure <code className="mono">HUB_URL</code> as the base URL of this service. Examples use versioned REST endpoints and JSON request bodies.</div></div>
      <div className="docs-steps">
        <div className="docs-step"><span>01 / SIGNAL</span><strong>Check in</strong><p>Tell other workers what you intend to change.</p></div>
        <div className="docs-step"><span>02 / RESERVE</span><strong>Acquire paths</strong><p>Wait for a grant before editing shared files.</p></div>
        <div className="docs-step"><span>03 / FINISH</span><strong>Release + report</strong><p>Unlock paths and publish completion.</p></div>
      </div>
      {snippets.map((snippet) => <section className="docs-section" key={snippet.id} id={snippet.id}>
        <div className="eyebrow">{snippet.endpoint}</div><h2>{snippet.title}</h2><p>{snippet.description}</p>
        <div className="codebox"><div className="codebar"><span>{snippet.endpoint} / cURL</span><button onClick={() => void copy(snippet.id, snippet.code)} data-testid={`button-copy-${snippet.id}`}><Copy size={12} />{copied === snippet.id ? 'Copied' : copied === `error-${snippet.id}` ? 'Copy unavailable' : 'Copy example'}</button></div><pre><code>{snippet.code}</code></pre></div>
      </section>)}
      <section className="docs-section"><div className="eyebrow">SERVICE BEHAVIOR</div><h2>Shared state stays visible</h2><p>Dashboard and registry state can be read from <code className="mono">GET /api/v1/dashboard</code>, <code className="mono">GET /api/v1/locks</code>, and <code className="mono">GET /api/v1/log/today</code>. The coordination console refreshes these feeds every six seconds.</p><p>A denied lock response means requested paths overlap existing ownership. Inspect the active lock list, wait for release or expiry, then retry. Never assume a lock was granted until the response says <code className="mono">granted: true</code>.</p></section>
      <div className="docs-callout"><Terminal size={16} /><div>Keep an agent identifier stable across check-ins, acquisitions, and releases. Ownership is scoped to that identifier.</div></div>
    </div>
  </>;
}

function Router() {
  return <Shell><Switch><Route path="/" component={Dashboard} /><Route path="/docs" component={Docs} /><Route component={NotFound} /></Switch></Shell>;
}

function App() {
  return <QueryClientProvider client={client}><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter></QueryClientProvider>;
}

export default App;
