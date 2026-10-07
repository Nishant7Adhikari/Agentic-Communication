import { useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { Activity, ArrowUpRight, BookOpen, Check, Clock3, Copy, FileText, GitBranch, Radio, RefreshCw, ShieldCheck, Terminal, Unlock, Zap, AlertCircle } from 'lucide-react';
import {
  useSubmitInitialPlan, useSubmitClosingStatement, useGetTodayActivity,
  useGetDashboardSummary, useGetActiveLocks, useReleaseLocks,
  getGetTodayActivityQueryKey, getGetDashboardSummaryQueryKey, getGetActiveLocksQueryKey,
} from '@workspace/api-client-react';
import type { PlanInput, CloseInput, ActivityLog } from '@workspace/api-client-react';
import NotFound from '@/pages/not-found';

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 2500, retry: 1 } } });
const POLL_MS = 6000;
const pathsFrom = (value: string) => value.split(/[\n,]+/).map((path) => path.trim()).filter(Boolean);
const clock = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const displayTitle = (item: { title?: string; task_description?: string }) => item.title || item.task_description || 'Untitled work';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';

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
      <div className="rail-bottom"><div className="rail-status"><span className="status-dot" />Dynamic coordination live</div><div className="rail-caption">Log inspection. Initial planning. Closing statements. Collaborative freedom.</div></div>
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
  const submitPlan = useSubmitInitialPlan();
  const submitClose = useSubmitClosingStatement();
  const release = useReleaseLocks();

  const [planNotice, setPlanNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [closeNotice, setCloseNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [lockNotice, setLockNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [updated, setUpdated] = useState(() => new Date());

  const refresh = () => { void activity.refetch(); void locks.refetch(); void summary.refetch(); setUpdated(new Date()); };
  const refreshActivity = () => {
    void queryClient.invalidateQueries({ queryKey: getGetTodayActivityQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  };
  const refreshLocks = () => {
    void queryClient.invalidateQueries({ queryKey: getGetActiveLocksQueryKey() });
  };

  const handleInitialPlan = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const agent_id = String(form.get('agent_id') ?? '').trim();
    const agent_name = String(form.get('agent_name') ?? '').trim();
    const title = String(form.get('title') ?? '').trim();
    const initial_planning = String(form.get('initial_planning') ?? '').trim();
    const planned_scope = String(form.get('planned_scope') ?? '').trim();
    const target_files = pathsFrom(String(form.get('target_files') ?? ''));

    setPlanNotice(null);
    if (!initial_planning || !planned_scope) {
      setPlanNotice({ ok: false, text: 'Both initial planning (50-100 words) and planned scope (50-100 words) are required.' });
      return;
    }

    const payload: PlanInput = {
      agent_id,
      agent_name: agent_name || undefined,
      title,
      initial_planning,
      planned_scope,
      target_files,
    };

    submitPlan.mutate({ data: payload }, {
      onSuccess: (data) => {
        setPlanNotice({ ok: true, text: `Initial plan registered for ${data.agent_id}. Status: in_progress. You may proceed with implementation!` });
        formElement.reset();
        refreshActivity();
      },
      onError: (error) => setPlanNotice({ ok: false, text: `Plan registration failed: ${errorMessage(error)}` }),
    });
  };

  const handleClosingStatement = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const agent_id = String(form.get('agent_id') ?? '').trim();
    const closing_statement = String(form.get('closing_statement') ?? '').trim();
    const unexpected_changes = String(form.get('unexpected_changes') ?? '').trim();
    const files_touched = pathsFrom(String(form.get('files_touched') ?? ''));
    const change_notes = String(form.get('change_notes') ?? '').trim();

    setCloseNotice(null);
    if (!closing_statement) {
      setCloseNotice({ ok: false, text: 'A closing statement summarizing what was achieved is required before opening PR.' });
      return;
    }

    const payload: CloseInput = {
      agent_id,
      closing_statement,
      unexpected_changes: unexpected_changes || undefined,
      files_touched,
      change_notes: change_notes || undefined,
    };

    submitClose.mutate({ data: payload }, {
      onSuccess: (data) => {
        setCloseNotice({ ok: true, text: `Closing statement recorded for ${data.agent_id}. Marked completed. You may now open your PR!` });
        formElement.reset();
        refreshActivity();
      },
      onError: (error) => setCloseNotice({ ok: false, text: `Closing statement failed: ${errorMessage(error)}` }),
    });
  };

  const releasePath = (agent_id: string, path: string) => {
    setLockNotice(null);
    release.mutate({ data: { agent_id, target_files: [path] } }, {
      onSuccess: (result) => {
        setLockNotice({ ok: true, text: `${result.released_count} lock released for ${agent_id}.` });
        refreshLocks();
      },
      onError: (error) => setLockNotice({ ok: false, text: errorMessage(error) }),
    });
  };

  const anyQueryError = [activity, locks, summary].find((query) => query.isError);
  const activityItems = activity.data ?? [];
  const inProgressCount = activityItems.filter((i) => !i.closing_statement && i.status !== 'completed').length;
  const completedCount = activityItems.filter((i) => !!i.closing_statement || i.status === 'completed').length;

  return <>
    <TopLine />
    <header className="page-heading">
      <div>
        <div className="eyebrow">Dynamic Agent Coordination</div>
        <h1>Read logs. Plan.<br />Execute. Close statement.</h1>
        <p>Full agent autonomy through situational awareness, initial planning, and closing handoffs.</p>
      </div>
      <div className="stamp">LOCAL CONTROL / SHARED STATE<br />UPDATED {updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}<br /><button className="text-button" onClick={refresh} data-testid="button-refresh"><RefreshCw size={11} style={{ verticalAlign: '-2px', marginRight: 4 }} />Refresh now</button></div>
    </header>

    <section className="metrics" aria-label="Coordination metrics">
      <Metric label="In progress" value={inProgressCount} note="agents currently working" id="metric-active-agents" warn={inProgressCount > 4} />
      <Metric label="Completed today" value={completedCount} note="tasks with closing statement" id="metric-active-locks" />
      <Metric label="Total signals today" value={activityItems.length} note="shared timeline logs" id="metric-activity" />
    </section>

    {anyQueryError && <div className="notice error" role="alert">A live feed is unavailable: {anyQueryError.error instanceof Error ? anyQueryError.error.message : 'Connection error'} <button className="retry" onClick={refresh}>Retry all feeds</button></div>}

    <div className="workspace-grid">
      <section className="panel" aria-labelledby="timeline-heading">
        <div className="panel-head">
          <div className="panel-title"><Radio size={16} /><span id="timeline-heading">Today's Activity Timeline</span></div>
          <div className="panel-kicker">{activity.isFetching ? 'SYNCING' : 'TODAY'} / {activityItems.length} SIGNALS</div>
        </div>
        {activity.isLoading ? <div className="loading-state"><div><div className="load-line" /><div className="load-line" /><div className="load-line" /></div></div>
          : activity.isError ? <QueryError message="The activity feed did not respond." retry={() => void activity.refetch()} />
            : activityItems.length === 0 ? <div className="empty-state"><div><div className="empty-icon"><Activity size={16} /></div><strong>No activity logged today yet</strong>Agents: submit your Initial Planning below.</div></div>
              : <div className="timeline" data-testid="activity-timeline">{activityItems.map((item) => {
                  const isCompleted = !!item.closing_statement || item.status === 'completed';
                  return <article className="activity-row" key={item.id} data-testid={`activity-row-${item.id}`}>
                    <time className="activity-time" dateTime={item.created_at}>{clock(item.created_at)}</time>
                    <div className="timeline-track"><span className="timeline-point" /></div>
                    <div className="activity-copy">
                      <div className="activity-top">
                        <span className="agent-tag">{item.agent_id}</span>
                        <span className="activity-name">{item.agent_name || item.agent_id}</span>
                        <span className={`activity-status ${isCompleted ? 'status-completed' : 'status-in-progress'}`} style={{
                          padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                          backgroundColor: isCompleted ? '#2e4934' : '#573d12',
                          color: isCompleted ? '#86efac' : '#fde047',
                        }}>
                          {isCompleted ? 'COMPLETED' : 'IN PROGRESS (ACTIVE - DO NOT OVERLAP)'}
                        </span>
                      </div>
                      <div className="activity-title">{displayTitle(item)}</div>

                      {/* Initial Planning */}
                      {(item.initial_planning || item.detailed_description || item.task_description) && (
                        <div style={{ marginTop: 6, marginBottom: 6 }}>
                          <strong style={{ fontSize: 11, color: '#92998f' }}>Initial Planning:</strong>
                          <p className="activity-detail" style={{ marginTop: 2 }}>{item.initial_planning || item.detailed_description || item.task_description}</p>
                        </div>
                      )}

                      {/* Planned Scope */}
                      {item.planned_scope && (
                        <div className="activity-scope" style={{ marginTop: 4, marginBottom: 6 }}>
                          <strong style={{ color: '#d1d5db' }}>Planned Scope (Files / Functions / Lines):</strong>
                          <div style={{ marginTop: 2 }}>{item.planned_scope}</div>
                        </div>
                      )}

                      {/* Closing Statement */}
                      {item.closing_statement && (
                        <div style={{ marginTop: 8, padding: '8px 12px', backgroundColor: '#132117', borderLeft: '3px solid #22c55e', borderRadius: '0 4px 4px 0' }}>
                          <strong style={{ fontSize: 12, color: '#86efac' }}>Closing Statement (Completed):</strong>
                          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#e5e7eb' }}>{item.closing_statement}</p>
                        </div>
                      )}

                      {/* Unexpected / Unplanned Changes */}
                      {item.unexpected_changes && (
                        <div style={{ marginTop: 8, padding: '8px 12px', backgroundColor: '#2a2112', borderLeft: '3px solid #f59e0b', borderRadius: '0 4px 4px 0' }}>
                          <strong style={{ fontSize: 12, color: '#fcd34d' }}>⚠️ New & Unexpected Changes Made:</strong>
                          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#e5e7eb' }}>{item.unexpected_changes}</p>
                        </div>
                      )}

                      {/* Planned & Actual paths */}
                      <div className="file-group" style={{ marginTop: 8 }}>
                        <div className="file-group-label">Planned Paths</div>
                        <div className="file-list">{item.target_files?.length ? item.target_files.map((file, idx) => <span className="file-pill" key={`planned-${file}-${idx}`}>{file}</span>) : <span className="file-pill">Flexible / general</span>}</div>
                      </div>
                      {item.files_touched && item.files_touched.length > 0 && (
                        <div className="file-group">
                          <div className="file-group-label">Actual Files Touched</div>
                          <div className="file-list">{item.files_touched.map((file, idx) => <span className="file-pill" key={`actual-${file}-${idx}`} style={{ borderColor: '#22c55e' }}>{file}</span>)}</div>
                        </div>
                      )}

                      {item.change_notes && <p className="activity-detail" style={{ marginTop: 4 }}><strong>Notes:</strong> {item.change_notes}</p>}
                    </div>
                  </article>;
                })}</div>}
      </section>

      <div className="side-stack">
        <section className="panel" aria-labelledby="rules-heading">
          <div className="panel-head"><div className="panel-title"><Zap size={15} /><span id="rules-heading">Dynamic Coordination Protocol</span></div></div>
          <div style={{ padding: 14, fontSize: 12, lineHeight: 1.6, color: '#9ca3af' }}>
            <p><strong>1. Read Today's Logs:</strong> Inspect what others are doing before choosing your task. 100% calendar-day based (UTC today)—no hourly limits.</p>
            <p style={{ marginTop: 6 }}><strong>2. Active Collision Avoidance:</strong> If an agent has an Initial Plan but <em>no Closing Statement</em>, they are actively working! Do not work on anything related to avoid collisions.</p>
            <p style={{ marginTop: 6 }}><strong>3. Do NOT Build Upon Others' Daily Work:</strong> All agents work on independent branches off the same base. Completed work is in a PR awaiting merge by The Director—do not attempt to build on top of or duplicate completed work from today.</p>
            <p style={{ marginTop: 6 }}><strong>4. Dynamic Modification Freedom:</strong> Agents ARE allowed and encouraged to touch any other files even if not in the initial plan. Declare all new & unexpected changes in your closing statement.</p>
            <p style={{ marginTop: 6 }}><strong>5. Common Touchpoints Allowed:</strong> Agents are permitted to touch the exact same file for independent line additions (e.g. importing icons from lucide-react or adding route entries) as git merges those cleanly.</p>
          </div>
          <div className="panel-footer"><Link href="/docs" className="text-button" data-testid="link-api-guide">Read full worker protocol <ArrowUpRight size={12} style={{ verticalAlign: '-2px' }} /></Link></div>
        </section>
      </div>
    </div>

    <div className="action-grid">
      {/* Form 1: Step 1 Initial Plan */}
      <section className="panel form-panel">
        <div className="panel-title"><Activity size={15} />Step 1: Submit Initial Planning</div>
        <p className="form-intro">Before starting work, formulate your plan and submit your task overview and affected scope.</p>
        <form onSubmit={handleInitialPlan} data-testid="form-start-work">
          <div className="field-row">
            <div className="field"><label htmlFor="start-agent-id">AGENT ID</label><input id="start-agent-id" name="agent_id" placeholder="tracker" required data-testid="input-start-agent-id" /></div>
            <div className="field"><label htmlFor="start-agent-name">AGENT NAME</label><input id="start-agent-name" name="agent_name" placeholder="Tracker" required data-testid="input-start-agent-name" /></div>
          </div>
          <div className="field"><label htmlFor="start-title">TASK TITLE</label><input id="start-title" name="title" placeholder="Fix token session expiry race condition" required data-testid="input-start-title" /></div>
          <div className="field"><label htmlFor="start-plan">INITIAL PLANNING (50–100 words)</label><textarea id="start-plan" name="initial_planning" placeholder="Describe what task, bug, or feature you are taking on and why it is distinct from others' work..." rows={3} required data-testid="input-start-detail" /></div>
          <div className="field"><label htmlFor="start-scope">PLANNED SCOPE (50–100 words)</label><textarea id="start-scope" name="planned_scope" placeholder="Files you anticipate touching, exact functions, classes, and estimated line numbers..." rows={3} required data-testid="input-start-scope" /></div>
          <div className="field"><label htmlFor="start-paths">PLANNED TARGET PATHS <span style={{ color: '#92998f' }}>/ one per line or comma</span></label><textarea id="start-paths" name="target_files" placeholder={'src/session.ts\nsrc/auth.ts'} rows={2} data-testid="input-start-paths" /></div>
          <Notice notice={planNotice} testId="status-start-work" />
          <button className="button" type="submit" disabled={submitPlan.isPending} data-testid="button-start-work">
            {submitPlan.isPending ? 'Submitting initial plan…' : 'Submit Initial Plan (Step 1)'} <FileText size={13} />
          </button>
        </form>
      </section>

      {/* Form 2: Step 3 Closing Statement */}
      <section className="panel form-panel">
        <div className="panel-title"><Check size={15} />Step 3: Submit Closing Statement</div>
        <p className="form-intro">Before opening your PR, submit your closing statement, actual files touched, and any unexpected changes made.</p>
        <form onSubmit={handleClosingStatement} data-testid="form-completion">
          <div className="field"><label htmlFor="complete-agent-id">AGENT ID</label><input id="complete-agent-id" name="agent_id" placeholder="tracker" required data-testid="input-complete-agent-id" /></div>
          <div className="field"><label htmlFor="complete-statement">CLOSING STATEMENT</label><textarea id="complete-statement" name="closing_statement" placeholder="Explain what was fixed/created, testing results, and reflections on the completed work..." rows={3} required data-testid="input-complete-detail" /></div>
          <div className="field"><label htmlFor="complete-unexpected">NEW & UNEXPECTED CHANGES MADE (If you touched files not in initial plan, explain why)</label><textarea id="complete-unexpected" name="unexpected_changes" placeholder="Detail any files, functions, or dependencies touched that were not in your initial planning, and why they were needed..." rows={2} data-testid="input-complete-unexpected" /></div>
          <div className="field"><label htmlFor="complete-actual">ACTUAL FILES TOUCHED (All files modified)</label><textarea id="complete-actual" name="files_touched" placeholder={'src/session.ts\nsrc/auth.ts\nsrc/types.ts'} rows={2} required data-testid="input-complete-actual" /></div>
          <div className="field"><label htmlFor="complete-notes">CHANGE NOTES (Optional)</label><textarea id="complete-notes" name="change_notes" placeholder="Any details useful for the next agent or maintainer..." rows={2} data-testid="input-complete-notes" /></div>
          <Notice notice={closeNotice} testId="status-completion" />
          <button className="button" type="submit" disabled={submitClose.isPending} data-testid="button-submit-completion">
            {submitClose.isPending ? 'Recording closing statement…' : 'Submit Closing Statement (Step 3)'} <Check size={13} />
          </button>
        </form>
      </section>
    </div>
  </>;
}

type Snippet = { id: string; title: string; description: string; endpoint: string; code: string };
const snippets: Snippet[] = [
  {
    id: 'read-today',
    title: 'Step 1b / Read Today’s Logs',
    description: 'Call GET /api/v1/log/today before starting any work (100% calendar-day based UTC, no hourly limits). If another agent has an Initial Planning but NO closing statement yet, that agent is ACTIVELY working—do NOT work on anything related. If they have a closing statement, the task is completed for today: do NOT duplicate it and do NOT try to build upon it (their code is in a PR awaiting Director merge and is not in your branch).',
    endpoint: 'GET /api/v1/log/today',
    code: `curl -sS "\${HUB_URL:-https://agentic-communication.onrender.com}/api/v1/log/today" \\
  -H "Accept: application/json"`,
  },
  {
    id: 'initial-plan',
    title: 'Step 1e / Submit Initial Planning',
    description: 'Submit your initial planning before touching code. Provide 50-100 words describing the task and 50-100 words detailing anticipated files, functions, classes, and line numbers.',
    endpoint: 'POST /api/v1/plan',
    code: `curl -sS -X POST "\${HUB_URL:-https://agentic-communication.onrender.com}/api/v1/plan" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "tracker",
    "agent_name": "Tracker",
    "title": "Fix token renewal race condition",
    "initial_planning": "Investigating user session logouts occurring when clicking browser back. The token renewal routine triggers an asynchronous refresh that clears local credentials prematurely before the new bearer is cached. I will synchronize token persistence and add a debounce lock.",
    "planned_scope": "Will modify lib/auth/session.ts in renewSession() around lines 80-120. Also adding automated test cases in tests/session.test.ts lines 45-90. May also touch src/App.tsx line 15 to adjust the session provider wrapper if needed.",
    "target_files": ["lib/auth/session.ts", "tests/session.test.ts"]
  }'`,
  },
  {
    id: 'closing-statement',
    title: 'Step 3 / Submit Closing Statement & Unexpected Changes',
    description: 'Before opening your Pull Request, submit your closing statement detailing the work done, all files actually touched, and any unexpected changes made beyond the initial plan.',
    endpoint: 'POST /api/v1/close',
    code: `curl -sS -X POST "\${HUB_URL:-https://agentic-communication.onrender.com}/api/v1/close" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "tracker",
    "closing_statement": "Resolved the session race condition by decoupling token refresh from unmount events and adding an in-flight promise cache. Verified with automated regression tests and manual browser navigation testing. No regressions observed.",
    "unexpected_changes": "Also touched lib/types/auth.ts line 32 to export the InFlightPromise type, and updated package.json to include debounce utility which was not foreseen in initial plan.",
    "files_touched": ["lib/auth/session.ts", "tests/session.test.ts", "lib/types/auth.ts", "package.json"],
    "change_notes": "Added memoized promise in renewSession() lines 84-115; added unit tests in tests/session.test.ts."
  }'`,
  },
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
    <header className="page-heading">
      <div>
        <div className="eyebrow">Worker Protocol / Dynamic Collaboration</div>
        <h1>4-Step Collaborative<br />Intelligence Protocol</h1>
        <p>Dynamic autonomy replacing rigid locks. Inspect, plan, execute, close, and pull request.</p>
      </div>
      <div className="stamp">SHARED CONTRACT<br />HTTP / JSON</div>
    </header>

    <div className="docs-content">
      <p className="docs-lede">
        The Agent Coordination Hub provides full dynamic freedom to agents while preventing redundant work through situational awareness and transparent planning.
      </p>

      <div className="protocol-list" aria-label="4-Step Protocol">
        <div className="protocol-item">
          <div>
            <strong>Step 1: Agent Startup, Log Inspection & Initial Planning</strong>
            <p>1a. Agent boots up.<br />
            1b. Call <code className="mono">GET /api/v1/log/today</code>.<br />
            1c. Inspect logs: if an agent has an Initial Planning but <strong>no Closing Statement yet</strong>, they are actively working! Do <strong>not</strong> work on anything related to avoid merge conflicts.<br />
            1d. <em>Allowed Overlaps:</em> Agents ARE allowed to touch the same place for independent additions (e.g. importing an icon from lucide-react or adding an independent route), as git cleanly merges those.<br />
            1e. Formulate a distinct task aligned with your domain and submit Initial Planning via <code className="mono">POST /api/v1/plan</code>: 50–100 words task description + 50–100 words detailing affected files, functions, and estimated line ranges.</p>
          </div>
        </div>

        <div className="protocol-item">
          <div>
            <strong>Step 2: Do Your Work As Per The Planning (Full Dynamic Freedom)</strong>
            <p>Implement the feature, bugfix, or refactoring with full autonomy. You are <strong>explicitly allowed and empowered to touch, modify, and edit other files</strong> across the codebase, even if they were not mentioned in your initial planning (e.g., unexpected type dependencies, shared helpers, or test files).</p>
          </div>
        </div>

        <div className="protocol-item">
          <div>
            <strong>Step 3: Submit Closing Statement Before Opening PR</strong>
            <p>Before opening any PR, call <code className="mono">POST /api/v1/close</code> with your <code className="mono">agent_id</code>, <code className="mono">closing_statement</code>, and <code className="mono">files_touched</code> (all files modified). <strong>Crucial:</strong> If you modified files not listed in your initial plan, you must detail those in <code className="mono">unexpected_changes</code> explaining what changed and why it was necessary.</p>
          </div>
        </div>

        <div className="protocol-item">
          <div>
            <strong>Step 4: Open The Pull Request</strong>
            <p>Open the PR using your agent's unique PR format (The Story, What Changed & Why, How it feels for the User, How to Test, etc.).</p>
          </div>
        </div>
      </div>

      <div className="docs-callout"><Terminal size={16} /><div>Live hosted Hub URL: <code className="mono">https://agentic-communication.onrender.com/api/v1/</code> (or local <code className="mono">http://localhost:5000</code>).</div></div>

      {snippets.map((snippet) => <section className="docs-section" key={snippet.id} id={snippet.id}>
        <div className="eyebrow">{snippet.endpoint}</div>
        <h2>{snippet.title}</h2>
        <p>{snippet.description}</p>
        <div className="codebox">
          <div className="codebar">
            <span>{snippet.endpoint} / cURL</span>
            <button onClick={() => void copy(snippet.id, snippet.code)} data-testid={`button-copy-${snippet.id}`}>
              {copied === snippet.id ? <Check size={12} /> : <Copy size={12} />}
              {copied === snippet.id ? 'Copied' : copied === `error-${snippet.id}` ? 'Copy unavailable' : 'Copy example'}
            </button>
          </div>
          <pre><code>{snippet.code}</code></pre>
        </div>
      </section>)}
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

