import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type AssistantLogEntry } from '../../api';
import {
  describeAssistantAction,
  validateAssistantAction,
  type AssistantAction,
  type AssistantUiContext,
} from '../../assistant';

/** Same limits the backend enforces. */
const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY = 20;
const MAX_HISTORY_REPLY_CHARS = 20000;

export interface ActionResult {
  ok: boolean;
  detail?: string;
}

interface AssistantWidgetProps {
  /** Current interface state, read when a question is sent. */
  getContext: () => AssistantUiContext;
  /** Runs one validated action on the interface. */
  onAction: (action: AssistantAction) => ActionResult;
}

interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  /** Labels of the actions this reply ran (or refused). */
  actions?: { label: string; ok: boolean }[];
  cached?: boolean;
}

function newConversationId(): string {
  return crypto.randomUUID();
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.detail ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

/** One line per logged event, in plain words. */
function describeLogEntry(entry: AssistantLogEntry): string {
  const f = entry as Record<string, unknown>;
  switch (entry.event) {
    case 'request_received':
      return `Question: ${String(f.preview ?? '')}`;
    case 'model_call':
      return `${String(f.served_by ?? f.model)} · ${f.input_tokens} in / ${f.output_tokens} out · ${f.latency_ms} ms · ${f.stop_reason}`;
    case 'tool_call':
      return `Tool ${String(f.name)} ${f.ok ? 'ok' : `failed: ${String(f.error ?? '')}`}`;
    case 'ui_action':
      return `Action ${JSON.stringify(f.action)}`;
    case 'ui_outcome':
      return `Browser ${String(f.status)} ${JSON.stringify(f.action)}`;
    case 'cache_hit':
      return `Answered from cache (${String(f.kind)})`;
    case 'guardrail':
      return `Guardrail: ${String(f.kind)}`;
    case 'response':
      return `Reply${f.cached ? ' (cached)' : ''}: ${String(f.preview ?? '')}`;
    case 'error':
      return `Error: ${String(f.kind)}${f.status ? ` (${String(f.status)})` : ''}`;
    default:
      return entry.event;
  }
}

export function AssistantWidget({ getContext, onAction }: AssistantWidgetProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'chat' | 'activity'>('chat');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [conversationId, setConversationId] = useState(newConversationId);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<AssistantLogEntry[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || enabled !== null) return;
    api
      .assistantStatus()
      .then((status) => setEnabled(status.enabled))
      .catch(() => setEnabled(false));
  }, [open, enabled]);

  useEffect(() => {
    listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight });
  }, [entries]);

  const loadLogs = useCallback(async () => {
    try {
      const page = await api.assistantLogs({ limit: 200, conversationId });
      setLogs(page.items);
      setLogsError(null);
    } catch (err) {
      setLogsError(errorText(err));
    }
  }, [conversationId]);

  useEffect(() => {
    if (open && tab === 'activity') void loadLogs();
  }, [open, tab, loadLogs]);

  /** Validate and run each action, then tell the backend log what happened. */
  const runActions = (raw: unknown[], requestId: string): { label: string; ok: boolean }[] =>
    raw.map((candidate) => {
      const checked = validateAssistantAction(candidate);
      let result: ActionResult;
      let label: string;
      if ('error' in checked) {
        result = { ok: false, detail: checked.error };
        label = `Refused: ${checked.error}`;
      } else {
        result = onAction(checked.action);
        label = describeAssistantAction(checked.action);
      }
      void api
        .reportAssistantOutcome({
          conversation_id: conversationId,
          request_id: requestId,
          action: (candidate && typeof candidate === 'object' ? candidate : {}) as Record<string, unknown>,
          status: 'error' in checked ? 'rejected' : result.ok ? 'executed' : 'failed',
          detail: result.detail ?? '',
        })
        .catch(() => {
          // Logging the outcome is best effort; the action already ran.
        });
      return { label, ok: result.ok };
    });

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || enabled === false) return;
    // Replies go back as history; clip them to the backend limit so a long
    // answer can never make the next turn fail.
    const history = entries
      .map(({ role, content }) => ({
        role,
        content: role === 'assistant' ? content.slice(0, MAX_HISTORY_REPLY_CHARS) : content,
      }))
      .slice(-MAX_HISTORY);
    setSending(true);
    setError(null);
    setDraft('');
    setEntries((prev) => [...prev, { role: 'user', content: text }]);
    try {
      const response = await api.assistantChat({
        conversation_id: conversationId,
        messages: [...history, { role: 'user', content: text }],
        context: getContext(),
      });
      const actions = runActions(response.actions, response.request_id);
      setEntries((prev) => [
        ...prev,
        { role: 'assistant', content: response.reply, actions, cached: response.cached },
      ]);
    } catch (err) {
      // Drop the unanswered question so the history keeps alternating; keep its text.
      setEntries((prev) => prev.slice(0, -1));
      setDraft(text);
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  const reset = () => {
    setConversationId(newConversationId());
    setEntries([]);
    setLogs([]);
    setError(null);
  };

  return (
    <>
      <button
        type="button"
        className={`assistant-launcher ${open ? 'is-open' : ''}`}
        aria-label={open ? 'Close assistant' : 'Open assistant'}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 5h16v11H9l-5 4z" />
            <path d="M8 9.5h8M8 12.5h5" />
          </svg>
        )}
      </button>

      {open && (
        <section className="assistant-panel" role="dialog" aria-label="Planet X assistant">
          <header className="assistant-header">
            <strong>Assistant</strong>
            <div className="assistant-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>
                Chat
              </button>
              <button type="button" role="tab" aria-selected={tab === 'activity'} onClick={() => setTab('activity')}>
                Activity
              </button>
            </div>
            <button type="button" className="assistant-reset" onClick={reset} title="Start a new conversation">
              New
            </button>
          </header>

          {tab === 'chat' ? (
            <>
              <div className="assistant-messages" ref={listRef}>
                {enabled === false && (
                  <p className="assistant-notice">
                    The assistant is disabled: set ASSISTANT_API_KEY and ASSISTANT_MODEL on the server to turn it on.
                  </p>
                )}
                {entries.length === 0 && enabled !== false && (
                  <p className="assistant-notice">
                    Ask about Planet X or tell me what to show, for example “show M101 in RGB” or “open Records”.
                  </p>
                )}
                {entries.map((entry, index) => (
                  <div key={index} className={`assistant-msg ${entry.role}`}>
                    {entry.role === 'assistant' ? (
                      <div className="assistant-markdown">
                        <Markdown remarkPlugins={[remarkGfm]} skipHtml>
                          {entry.content}
                        </Markdown>
                      </div>
                    ) : (
                      <p>{entry.content}</p>
                    )}
                    {entry.actions && entry.actions.length > 0 && (
                      <ul className="assistant-actions">
                        {entry.actions.map((action, i) => (
                          <li key={i} className={action.ok ? '' : 'failed'}>
                            {action.label}
                          </li>
                        ))}
                      </ul>
                    )}
                    {entry.cached && <span className="assistant-badge">From cache</span>}
                  </div>
                ))}
                {sending && <p className="assistant-notice">Thinking…</p>}
              </div>
              {error && (
                <p className="assistant-error" role="alert">
                  {error}
                </p>
              )}
              <form
                className="assistant-input"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <textarea
                  aria-label="Message the assistant"
                  placeholder="Ask or give an instruction…"
                  rows={2}
                  maxLength={MAX_MESSAGE_CHARS}
                  value={draft}
                  disabled={enabled === false}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <button type="submit" disabled={sending || !draft.trim() || enabled === false}>
                  Send
                </button>
              </form>
            </>
          ) : (
            <div className="assistant-activity">
              <div className="assistant-activity-bar">
                <span>This conversation, newest first</span>
                <button type="button" onClick={() => void loadLogs()}>
                  Refresh
                </button>
              </div>
              {logsError && (
                <p className="assistant-error" role="alert">
                  {logsError}
                </p>
              )}
              {logs.length === 0 && !logsError && <p className="assistant-notice">No activity yet.</p>}
              <ol className="assistant-log">
                {logs.map((entry, index) => (
                  <li key={index} className={`log-${entry.event}`}>
                    <time>{new Date(entry.ts).toLocaleTimeString()}</time>
                    <span>{describeLogEntry(entry)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}
    </>
  );
}
