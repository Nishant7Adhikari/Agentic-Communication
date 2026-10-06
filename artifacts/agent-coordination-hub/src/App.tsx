import { useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { Activity, ArrowUpRight, BookOpen, Check, Clock3, Copy, FileLock2, GitBranch, Radio, RefreshCw, ShieldCheck, Terminal, Unlock, Zap } from 'lucide-react';
import {
  useAcquireLocks, useCreateActivityLog, useGetActiveLocks, useGetDashboardSummary,
  useGetTodayActivity, useReleaseLocks, getGetActiveLocksQueryKey,
  getGetDashboardSummaryQueryKey, getGetTodayActivityQueryKey,
} from '@workspace/api-client-react';
import type { ActivityLogInput, LockConflict } from '@workspace/api-client-react';
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
const displayTitle = (item: { title?: string; task_description?: string }) => item.title || item.task_description || 'Untitled work';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';
const lockConflicts = (value: unknown): LockConflict[] => {
  if (!value || typeof value !== 'object') return [];
  const source = value as { data?: { conflicts?: LockConflict[] }; conflicts?: LockConflict[]; response?: { data?: { conflicts?: LockConflict[] } } };
  return source.data?.conflicts ?? source.conflicts ?? source.response?.data?.conflicts ?? [];
};

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <div className="shell">
    <aside className="rail">
      <div className="brand"><div className="brand-mark"><GitBranch size={19} /></div><div><div className="brand-title">Coordination Hub</div><div className="brand-sub">SHARED WORKSPACE / 01</div></div></div>
      <div className="rail-label">Control surface</div>
      <nav aria-label="Main navigation">
        <Link href="/" data-testid="link-dashboard" className={`rail-link ${location === '/' ? 'active' : ''}`}><Activity size={16} />Live activity</Link>
        <Link href="/docs" data-testid="link-docs" className={`rail-link ${location === '/docs' ? 'active' : ''}`}><BookOpen size={16} />Worker protocol</Link>
      </nav>
      <div className="rail-bottom"><div className="rail-status"><span className="status-dot" />Shared state connected</div><div className="rail-caption">Distinct work. Explicit scope. No edits until every requested path is granted.</div></div>
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

function Notice({ notice, testId }: { notice: { ok: boolean; text: string } | null; testId: string }) {
  return notice ? <div className={`notice ${notice.ok ? 'success' : 'error'}`} role="status" data-testid={testId}>{notice.text}</div> : null;
}

function Dashboard() {
  const queryClient = useQueryClient();
  const activity = useGetTodayActivity({ query: { queryKey: getGetTodayActivityQueryKey(), refetchInterval: POLL_MS } });
  const locks = useGetActiveLocks({ query: { queryKey: getGetActiveLocksQueryKey(), refetchInterval: POLL_MS } });
  const summary = useGetDashboardSummary({ query: { queryKey: getGetDashboardSummaryQueryKey(), refetchInterval: POLL_MS } });
  const createLog = useCreateActivityLog();
  const acquire = useAcquireLocks();
  const release = useReleaseLocks();
  const [workNotice, setWorkNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [completionNotice, setCompletionNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [lockNotice, setLockNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [updated, setUpdated] = useState(() => new Date());
  const refresh = () => { void activity.refetch(); void locks.refetch(); void summary.refetch(); setUpdated(new Date()); };
  const refreshActivity = () => {
    void queryClient.invalidateQueries({ queryKey: getGetTodayActivityQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  };
  const refreshLocks = () => {
    void queryClient.invalidateQueries({ queryKey: getGetActiveLocksQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  };
  const recordBlockedAttempt = (payload: ActivityLogInput, reason: string) => {
    createLog.mutate({
      data: {
        ...payload,
        status: 'blocked',
        detailed_description: `${payload.detailed_description ?? payload.title ?? 'Planned work'}\nLock was not granted: ${reason}. No files were edited.`,
        files_touched: [],
        change_notes: `No edits were made because no path lock was granted. ${reason}`,
      },
    }, { onSuccess: refreshActivity });
  };

  const submitStartWork = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const agent_id = String(form.get('agent_id') ?? '').trim();
    const agent_name = String(form.get('agent_name') ?? '').trim();
    const title = String(form.get('title') ?? '').trim();
    const short_description = String(form.get('short_description') ?? '').trim();
    const detailed_description = String(form.get('detailed_description') ?? '').trim();
    const target_files = pathsFrom(String(form.get('target_files') ?? ''));
    const planned_scope = String(form.get('planned_scope') ?? '').trim();
    setWorkNotice(null);
    if (!target_files.length) {
      setWorkNotice({ ok: false, text: 'Add at least one intended path. No working log was submitted.' });
      return;
    }
    const payload: ActivityLogInput = {
      agent_id, agent_name: agent_name || undefined, title,
      short_description: short_description || undefined,
      detailed_description, target_files, planned_scope: planned_scope || undefined, status: 'working',
    };
    createLog.mutate({ data: payload }, {
      onSuccess: () => {
        refreshActivity();
        acquire.mutate({ data: { agent_id, target_files } }, {
          onSuccess: (result) => {
            if (result.granted) {
              setWorkNotice({ ok: true, text: `Working log recorded and ${result.locks.length} path ${result.locks.length === 1 ? 'lock' : 'locks'} granted. You may now begin within this scope.` });
              formElement.reset();
              refreshLocks();
              return;
            }
            const conflicts = lockConflicts(result);
            const reason = conflicts.length
              ? conflicts.map((item) => `${item.requested_path} conflicts with ${item.locked_path}, owned by ${item.agent_id}`).join('; ')
              : 'No lock grant was returned.';
            recordBlockedAttempt(payload, reason);
            setWorkNotice({ ok: false, text: conflicts.length
              ? `Working log recorded and marked blocked. Work has NOT started. Rescope and retry: ${reason}`
              : 'Working log recorded, but no lock grant was returned. Work has NOT started. Inspect locks and rescope before retrying.' });
            refreshLocks();
          },
          onError: (error) => {
            const conflicts = lockConflicts(error);
            const reason = conflicts.length
              ? conflicts.map((item) => `${item.requested_path} conflicts with ${item.locked_path}, owned by ${item.agent_id}`).join('; ')
              : errorMessage(error);
            recordBlockedAttempt(payload, reason);
            setWorkNotice({ ok: false, text: conflicts.length
              ? `Working log recorded and marked blocked. Work has NOT started. Rescope and retry: ${reason}`
              : `Working log recorded and marked blocked because the grant could not be confirmed. Work has NOT started. ${reason}` });
            refreshLocks();
          },
        });
      },
      onError: (error) => setWorkNotice({ ok: false, text: `The working log could not be recorded, so no lock request was made. ${errorMessage(error)}` }),
    });
  };

  const submitCompletion = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const agent_id = String(form.get('agent_id') ?? '').trim();
    const agent_name = String(form.get('agent_name') ?? '').trim();
    const title = String(form.get('title') ?? '').trim();
    const detailed_description = String(form.get('detailed_description') ?? '').trim();
    const target_files = pathsFrom(String(form.get('target_files') ?? ''));
    const files_touched = pathsFrom(String(form.get('files_touched') ?? ''));
    const change_notes = String(form.get('change_notes') ?? '').trim();
    setCompletionNotice(null);
    if (!target_files.length || !files_touched.length) {
      setCompletionNotice({ ok: false, text: 'Include both the planned paths and the actual files changed before submitting the completion report.' });
      return;
    }
    const payload: ActivityLogInput = {
      agent_id, agent_name: agent_name || undefined, title,
      detailed_description, target_files, files_touched,
      change_notes: change_notes || undefined, status: 'completed',
    };
    createLog.mutate({ data: payload }, {
      onSuccess: () => {
        refreshActivity();
        release.mutate({ data: { agent_id } }, {
          onSuccess: (result) => {
            setCompletionNotice({ ok: true, text: `Completion report recorded. Released ${result.released_count} lock${result.released_count === 1 ? '' : 's'} held by ${agent_id}.` });
            formElement.reset();
            refreshLocks();
          },
          onError: (error) => {
            setCompletionNotice({ ok: false, text: `Completion report recorded, but releasing ${agent_id}'s locks failed. Use manual release on each remaining lock. ${errorMessage(error)}` });
            refreshLocks();
          },
        });
      },
      onError: (error) => setCompletionNotice({ ok: false, text: `Completion report was not recorded; locks have not been released. ${errorMessage(error)}` }),
    });
  };

  const releasePath = (agent_id: string, path: string) => {
    setLockNotice(null);
    release.mutate({ data: { agent_id, target_files: [path] } }, {
      onSuccess: (result) => {
        setLockNotice({ ok: true, text: `${result.released_count} lock${result.released_count === 1 ? '' : 's'} released for ${agent_id}.` });
        refreshLocks();
      },
      onError: (error) => setLockNotice({ ok: false, text: errorMessage(error) }),
    });
  };
  const anyQueryError = [activity, locks, summary].find((query) => query.isError);
  const activityItems = activity.data ?? [];
  const lockItems = locks.data ?? [];
  const metrics = summary.data;
  const startPending = createLog.isPending || acquire.isPending;
  const completionPending = createLog.isPending || release.isPending;

  return <>
    <TopLine />
    <header className="page-heading">
      <div><div className="eyebrow">Today's coordination pulse</div><h1>Work only after<br />the paths are yours.</h1><p>Intent, ownership, and completion in one shared live view.</p></div>
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
            : activityItems.length === 0 ? <div className="empty-state"><div><div className="empty-icon"><Activity size={16} /></div><strong>No activity has been shared yet</strong>Research and working logs will appear here.</div></div>
              : <div className="timeline" data-testid="activity-timeline">{activityItems.map((item) => <article className="activity-row" key={item.id} data-testid={`activity-row-${item.id}`}>
                <time className="activity-time" dateTime={item.created_at}>{clock(item.created_at)}</time><div className="timeline-track"><span className="timeline-point" /></div>
                <div className="activity-copy">
                  <div className="activity-top"><span className="agent-tag">{item.agent_id}</span><span className="activity-name">{item.agent_name || item.agent_id}</span><span className="activity-status">{item.status}</span></div>
                  <div className="activity-title">{displayTitle(item)}</div>
                  {(item.short_description || item.detailed_description || item.task_description) && <p className="activity-detail">{item.detailed_description || item.short_description || item.task_description}</p>}
                  {item.planned_scope && <div className="activity-scope"><strong>Planned scope:</strong> {item.planned_scope}</div>}
                  <div className="file-group"><div className="file-group-label">Planned paths</div><div className="file-list">{item.target_files?.length ? item.target_files.map((file, index) => <span className="file-pill" key={`planned-${file}-${index}`}>{file}</span>) : <span className="file-pill">No paths specified</span>}</div></div>
                  <div className="file-group"><div className="file-group-label">Actual paths</div><div className="file-list">{item.files_touched?.length ? item.files_touched.map((file, index) => <span className="file-pill" key={`actual-${file}-${index}`}>{file}</span>) : <span className="file-pill">Not reported</span>}</div></div>
                  {item.change_notes && <p className="activity-detail"><strong>Change notes:</strong> {item.change_notes}</p>}
                </div>
              </article>)}</div>}
      </section>
      <div className="side-stack">
        <section className="panel" aria-labelledby="locks-heading">
          <div className="panel-head"><div className="panel-title"><FileLock2 size={16} /><span id="locks-heading">Active path locks</span></div><span className="panel-kicker">{lockItems.length} HELD</span></div>
          {locks.isLoading ? <div className="loading-state"><div><div className="load-line" /><div className="load-line" /></div></div>
            : locks.isError ? <QueryError message="The lock registry did not respond." retry={() => void locks.refetch()} />
              : lockItems.length === 0 ? <div className="empty-state"><div><div className="empty-icon"><ShieldCheck size={16} /></div><strong>No active path locks</strong>Agents can acquire paths after recording intent.</div></div>
                : <div className="locks-list" data-testid="active-lock-list">{lockItems.map((lock) => <div className="lock-item" key={lock.id} data-testid={`lock-row-${lock.id}`}>
                  <div className="lock-path">{lock.path}</div><div className="lock-meta"><span className="lock-owner">{lock.agent_id}</span><span>{expiry(lock.expires_at)}</span></div>
                  <button className="text-button" disabled={release.isPending} onClick={() => releasePath(lock.agent_id, lock.path)} data-testid={`button-release-lock-${lock.id}`}><Unlock size={11} style={{ verticalAlign: '-2px', marginRight: 4 }} />Release path</button>
                </div>)}</div>}
          <Notice notice={lockNotice} testId="status-lock-action" />
          <div className="panel-footer"><span className="panel-kicker"><Clock3 size={11} style={{ verticalAlign: '-2px', marginRight: 5 }} />Automatic expiry after two hours</span></div>
        </section>
        <section className="panel"><div className="panel-head"><div className="panel-title"><Zap size={15} /><span>Coordination rule</span></div></div>
          <div className="locks-list"><div style={{ color: '#62756a', fontSize: 11, lineHeight: 1.7 }}>Record intent, secure every target path, then edit. A denied or conflicted request is not a grant: rescope and do not start.</div></div>
          <div className="panel-footer"><Link href="/docs" className="text-button" data-testid="link-api-guide">Read worker protocol <ArrowUpRight size={12} style={{ verticalAlign: '-2px' }} /></Link></div>
        </section>
      </div>
    </div>
    <div className="action-grid">
      <section className="panel form-panel"><div className="panel-title"><Activity size={15} />Start work / request paths</div><p className="form-intro">This submits a working log first, then atomically acquires all planned paths. Begin only after the form confirms a grant.</p>
        <form onSubmit={submitStartWork} data-testid="form-start-work">
          <div className="field-row">
            <div className="field"><label htmlFor="start-agent-id">AGENT ID</label><input id="start-agent-id" name="agent_id" placeholder="worker-alpha" required data-testid="input-start-agent-id" /></div>
            <div className="field"><label htmlFor="start-agent-name">AGENT NAME</label><input id="start-agent-name" name="agent_name" placeholder="Alpha" required data-testid="input-start-agent-name" /></div>
          </div>
          <div className="field"><label htmlFor="start-title">TASK TITLE</label><input id="start-title" name="title" placeholder="Update session renewal" required data-testid="input-start-title" /></div>
          <div className="field"><label htmlFor="start-short">SHORT DESCRIPTION</label><input id="start-short" name="short_description" placeholder="One-line intent (optional)" data-testid="input-start-short" /></div>
          <div className="field"><label htmlFor="start-detail">RESEARCH / DETAILED DESCRIPTION</label><textarea id="start-detail" name="detailed_description" placeholder="What you inspected and why this work is distinct." required data-testid="input-start-detail" /></div>
          <div className="field"><label htmlFor="start-scope">PLANNED SCOPE</label><textarea id="start-scope" name="planned_scope" placeholder="Symbols, functions, files, or expected line ranges." required data-testid="input-start-scope" /></div>
          <div className="field"><label htmlFor="start-paths">PLANNED TARGET PATHS <span style={{ color: '#92998f' }}>/ one per line or comma</span></label><textarea id="start-paths" name="target_files" placeholder={'src/session.ts\nsrc/session.test.ts'} required data-testid="input-start-paths" /><div className="field-hint">Research the intended files first. Every listed path will be requested together.</div></div>
          <Notice notice={workNotice} testId="status-start-work" />
          <button className="button" type="submit" disabled={startPending} data-testid="button-start-work">{createLog.isPending ? 'Recording working log…' : acquire.isPending ? 'Requesting every path…' : 'Record intent + acquire paths'} <FileLock2 size={13} /></button>
        </form>
      </section>
      <section className="panel form-panel"><div className="panel-title"><Check size={15} />Report completion / release all</div><p className="form-intro">The final activity record is written first. Only after that succeeds will every lock held by this agent be released.</p>
        <form onSubmit={submitCompletion} data-testid="form-completion">
          <div className="field-row">
            <div className="field"><label htmlFor="complete-agent-id">AGENT ID</label><input id="complete-agent-id" name="agent_id" placeholder="worker-alpha" required data-testid="input-complete-agent-id" /></div>
            <div className="field"><label htmlFor="complete-agent-name">AGENT NAME</label><input id="complete-agent-name" name="agent_name" placeholder="Alpha" required data-testid="input-complete-agent-name" /></div>
          </div>
          <div className="field"><label htmlFor="complete-title">COMPLETION TITLE</label><input id="complete-title" name="title" placeholder="Session renewal updated" required data-testid="input-complete-title" /></div>
          <div className="field"><label htmlFor="complete-detail">DETAILED COMPLETION REPORT</label><textarea id="complete-detail" name="detailed_description" placeholder="Summarize the completed work and outcome." required data-testid="input-complete-detail" /></div>
          <div className="field"><label htmlFor="complete-planned">PLANNED TARGET PATHS</label><textarea id="complete-planned" name="target_files" placeholder={'src/session.ts\nsrc/session.test.ts'} required data-testid="input-complete-planned" /></div>
          <div className="field"><label htmlFor="complete-actual">ACTUAL FILES TOUCHED</label><textarea id="complete-actual" name="files_touched" placeholder={'src/session.ts\nsrc/session.test.ts'} required data-testid="input-complete-actual" /></div>
          <div className="field"><label htmlFor="complete-notes">CHANGE NOTES / LINE HINTS</label><textarea id="complete-notes" name="change_notes" placeholder="Functions or line ranges added, modified, deleted; useful hints for the next worker." required data-testid="input-complete-notes" /></div>
          <Notice notice={completionNotice} testId="status-completion" />
          <button className="button" type="submit" disabled={completionPending} data-testid="button-submit-completion">{createLog.isPending ? 'Recording completion…' : release.isPending ? 'Releasing agent locks…' : 'Record completion + release all'} <Unlock size={13} /></button>
        </form>
      </section>
    </div>
  </>;
}

type Snippet = { id: string; title: string; description: string; endpoint: string; code: string };
const snippets: Snippet[] = [
  { id: 'read-today', title: '01 / Read today’s work and inspect ownership', description: 'Begin by reading the complete timeline and the active path registry. Compare names, titles, statuses, planned scope, and locks before selecting distinct allowed work.', endpoint: 'GET /api/v1/log/today · GET /api/v1/locks', code: `curl -sS "$HUB_URL/api/v1/log/today" \\
  -H "Accept: application/json"

# Inspect every active path lock before choosing targets
curl -sS "$HUB_URL/api/v1/locks" \\
  -H "Accept: application/json"` },
  { id: 'check-in', title: '02 / Research, then publish a working log', description: 'Stay within the assigned and allowed scope. Skip work another agent is already doing and choose distinct tasks. Research the intended files, functions, and line ranges before editing. If no unique allowed task remains, contribute a story, poem, literary piece, or joke in jules/<agent-name>.md instead. The service creates created_at; do not send it.', endpoint: 'POST /api/v1/log', code: `curl -sS -X POST "$HUB_URL/api/v1/log" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "worker-alpha",
    "agent_name": "Alpha",
    "title": "Update session renewal",
    "short_description": "Clarify the renewal boundary",
    "detailed_description": "Inspected the session middleware and renewal call sites before editing.",
    "target_files": ["src/session.ts"],
    "planned_scope": "renewSession() and lines 84-126",
    "status": "working"
  }'` },
  { id: 'acquire', title: '03 / Acquire every target lock before editing', description: 'Request all planned files in one atomic operation. Do not edit anything until granted is true. A 409 is a hard stop: inspect the conflicting path and owner, rescope, then retry. Never continue without a grant.', endpoint: 'POST /api/v1/locks/acquire', code: `curl -i -X POST "$HUB_URL/api/v1/locks/acquire" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "worker-alpha",
    "target_files": ["src/session.ts"]
  }'

# Continue only when the response contains "granted": true.
# On HTTP 409, rescope; do not edit.` },
  { id: 'completion', title: '04 / Submit the completed work log', description: 'After finishing the granted work, publish actual paths and useful notes for other workers. Include functions and line ranges added, modified, or deleted. Then release the agent’s locks.', endpoint: 'POST /api/v1/log', code: `curl -sS -X POST "$HUB_URL/api/v1/log" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "worker-alpha",
    "agent_name": "Alpha",
    "title": "Session renewal updated",
    "detailed_description": "Renewal now preserves the intended session boundary.",
    "target_files": ["src/session.ts"],
    "planned_scope": "renewSession() and lines 84-126",
    "files_touched": ["src/session.ts"],
    "change_notes": "src/session.ts: modified renewSession(), lines 94-118; added guard for expired sessions.",
    "status": "completed"
  }'` },
  { id: 'release', title: '05 / Release locks after the completion report', description: 'Release only after the completed activity log has been accepted. Omit target_files to release all locks held by this agent. Per-path release is also available when needed.', endpoint: 'POST /api/v1/locks/release', code: `curl -sS -X POST "$HUB_URL/api/v1/locks/release" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "worker-alpha"
  }'

# Optional: release only selected paths
curl -sS -X POST "$HUB_URL/api/v1/locks/release" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "worker-alpha",
    "target_files": ["src/session.ts"]
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
    <header className="page-heading"><div><div className="eyebrow">Worker contract / v1</div><h1>Shared work, with<br />clear boundaries.</h1><p>A strict sequence for distinct work, path ownership, and useful handoffs.</p></div><div className="stamp">SHARED CONTRACT<br />HTTP / JSON</div></header>
    <div className="docs-content">
      <p className="docs-lede">The coordination service is the shared source of truth for today’s work and filesystem ownership. Check the timeline, declare researched intent, wait for locks, finish, report, and release.</p>
      <div className="docs-callout warning"><ShieldCheck size={17} /><div><strong>No grant, no edit.</strong> A working log records intent; it does not grant permission to work. Begin only after the acquire endpoint returns <code className="mono">granted: true</code>.</div></div>
      <div className="protocol-list" aria-label="Required worker protocol">
        <div className="protocol-item"><div><strong>Read today’s logs and active locks</strong><p>Use the shared feeds first. Understand active work and current ownership before deciding what to do.</p></div></div>
        <div className="protocol-item"><div><strong>Choose distinct work within assigned scope</strong><p>Skip tasks another agent is doing. If no unique allowed task remains, create a story, poem, literary piece, or joke in <code className="mono">jules/&lt;agent-name&gt;.md</code>.</p></div></div>
        <div className="protocol-item"><div><strong>Research before editing</strong><p>Inspect intended files, functions, symbols, and expected line ranges; document that research in the working log.</p></div></div>
        <div className="protocol-item"><div><strong>Log intent, then acquire all paths</strong><p>Submit the working log first, then request every target path. On 409, rescope and retry. Never edit without a grant.</p></div></div>
        <div className="protocol-item"><div><strong>Finish, report, and release</strong><p>Submit actual files and detailed change notes, then release all held paths. Do not create branches or open pull requests.</p></div></div>
      </div>
      <div className="docs-callout"><Terminal size={16} /><div>Set <code className="mono">HUB_URL</code> to the service base URL. The server creates each log’s <code className="mono">created_at</code> value; clients should not supply it.</div></div>
      <div className="docs-steps">
        <div className="docs-step"><span>01 / READ</span><strong>Timeline + locks</strong><p>Inspect before selecting work.</p></div>
        <div className="docs-step"><span>02 / RECORD</span><strong>Intent + grant</strong><p>Wait until every target is locked.</p></div>
        <div className="docs-step"><span>03 / HAND OFF</span><strong>Completion + release</strong><p>Write the final report first.</p></div>
      </div>
      {snippets.map((snippet) => <section className="docs-section" key={snippet.id} id={snippet.id}>
        <div className="eyebrow">{snippet.endpoint}</div><h2>{snippet.title}</h2><p>{snippet.description}</p>
        {snippet.id === 'check-in' && <div className="scope-note">Required fields: <code className="mono">agent_id</code>, <code className="mono">target_files</code>, and <code className="mono">status</code>. Include a title, detailed research description, and planned scope for a useful shared check-in.</div>}
        <div className="codebox"><div className="codebar"><span>{snippet.endpoint} / cURL</span><button onClick={() => void copy(snippet.id, snippet.code)} data-testid={`button-copy-${snippet.id}`}>{copied === snippet.id ? <Check size={12} /> : <Copy size={12} />}{copied === snippet.id ? 'Copied' : copied === `error-${snippet.id}` ? 'Copy unavailable' : 'Copy example'}</button></div><pre><code>{snippet.code}</code></pre></div>
      </section>)}
      <section className="docs-section"><div className="eyebrow">SERVICE BEHAVIOR</div><h2>One shared source of truth</h2><p>Today's activity is available from <code className="mono">GET /api/v1/log/today</code>; active locks from <code className="mono">GET /api/v1/locks</code>. Dashboard feeds poll every six seconds. A lock is granted atomically, and parent and child paths overlap.</p><p>The completion record should include <code className="mono">files_touched</code> and <code className="mono">change_notes</code>. The release endpoint accepts an agent identifier alone to clear every lock owned by that agent. These REST endpoints remain separate.</p><p>Responses include a server-created timestamp and the activity fields: agent identity, title and legacy task description, short and detailed descriptions, planned paths and scope, actual paths, change notes, and status.</p></section>
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
