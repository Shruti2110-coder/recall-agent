'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Source = { title: string; url: string };
// One live activity step, e.g. "Searching the web". `ms` = time since the request started.
// `started` keeps the detail the step began with (for a search: the queries), since later updates replace `detail`.
type Step = { key: string; label: string; detail?: string; started?: string; done: boolean; ms: number };
type Message = {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  createdAt?: string;
  steps?: Step[];
  failed?: boolean;
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDay(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}

// "11 November 2026", in the user's local time.
function formatLongDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// "https://www.neon.com/pricing" -> "neon.com"
function siteName(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// The three verdicts used when re-checking an old answer, and their badge style.
// UNCHANGED comes before CHANGED, and \b means CHANGED inside UNCHANGED never matches.
const VERDICTS = /\b(UNCHANGED|CHANGED|COULD NOT VERIFY)\b/g;
const BADGE_CLASS: Record<string, string> = {
  CHANGED: 'badge changed',
  UNCHANGED: 'badge unchanged',
  'COULD NOT VERIFY': 'badge unverified',
};
// Invisible marker so we can tell our badges apart from real inline code.
const MARK = '⁣';

// Shown on the welcome screen. Clicking one sends it.
// `plan` is shown on the back of the card when it flips.
const EXAMPLES = [
  {
    question: 'On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?',
    plan: "Finds Monday's shortlist, then re-checks all 5 prices at once",
  },
  {
    question: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    plan: "Recalls last Tuesday's chat, then checks 4 providers in parallel",
  },
  { question: 'What did I ask you yesterday?', plan: 'Answers from memory. No web search needed' },
  { question: 'What is the latest version of Node.js?', plan: 'Searches the live web and cites its sources' },
];
const HEADLINE = 'Ask it now. Ask about it again next week.'.split(' ');

// Shows `text`. When it changes, the old words flip away and the new ones flip in,
// like a departure board (175ms out, then 175ms in).
// - The old label is drawn on top of the same spot and removed as soon as its flip-out ends,
//   so there is never more than one label left on the page.
// - If the text changes again while a flip is still running, that flip is cancelled and only
//   the newest text is shown, without animation.
// `turn` counts changes, so each flip gets fresh elements and its animation restarts.
const FLIP_MS = 350;

function FlipText({ text }: { text: string }) {
  const [state, setState] = useState({ text, previous: '', turn: 0, flipping: false });
  if (state.text !== text) {
    setState(
      state.flipping
        ? { text, previous: '', turn: state.turn + 1, flipping: false } // cancel the running flip
        : { text, previous: state.text, turn: state.turn + 1, flipping: true },
    );
  }

  const { turn, flipping } = state;
  // Backup for when `animationend` never fires (reduced motion, background tab):
  // end the flip and remove the old label after the full flip time.
  useEffect(() => {
    if (!flipping) return;
    const timer = setTimeout(
      () => setState((s) => (s.turn === turn ? { ...s, previous: '', flipping: false } : s)),
      FLIP_MS,
    );
    return () => clearTimeout(timer);
  }, [turn, flipping]);

  return (
    <span className="flip">
      {state.previous && (
        <span
          key={'out' + turn}
          className="flip-face flip-out"
          aria-hidden="true"
          onAnimationEnd={(event) => {
            if (event.animationName === 'flip-out') {
              setState((s) => (s.turn === turn ? { ...s, previous: '' } : s));
            }
          }}
        >
          <span className="flip-text">{state.previous}</span>
        </span>
      )}
      <span key={'in' + turn} className={flipping ? 'flip-face flip-in' : 'flip-face'}>
        <span className="flip-text">{state.text}</span>
      </span>
    </span>
  );
}

// The accent colours offered in the picker. The colours themselves live in globals.css.
const ACCENTS = [
  { id: 'blue', label: 'Blue' },
  { id: 'violet', label: 'Violet' },
  { id: 'orange', label: 'Orange' },
  { id: 'green', label: 'Green' },
  { id: 'mono', label: 'Black and white' },
];

// What a step looks like on screen. The model name is never shown: the Thinking step
// only says whether the backup model took over. (The server still sends the name, for logs.)
function shownStep(step: Step): { label: string; detail?: string } {
  if (step.key !== 'think') return { label: step.label, detail: step.detail };
  const switched = Boolean(step.detail?.includes('did not respond'));
  return {
    label: switched ? 'Thinking (switched to backup)' : 'Thinking',
    detail: step.detail === 'No model responded' ? step.detail : undefined,
  };
}

// Small line icons (inline SVG, drawn with the text colour).
const ICON_PATHS: Record<string, ReactNode> = {
  memory: <path d="M12 7v5l3 2M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9z" />,
  palette: (
    <>
      <path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z" />
      <circle cx="7.5" cy="11.5" r="1" />
      <circle cx="10.5" cy="7.5" r="1" />
      <circle cx="15" cy="8" r="1" />
    </>
  ),
  search: <path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5" />,
  sources: (
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  ),
  time: <path d="M12 10v4l2 1.5M10 2h4M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16z" />,
  rotate: <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
};

function Icon({ name }: { name: string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  );
}

// A finished answer. The round button turns the card over to show "How I answered",
// built only from what the page already has: the message's steps and sources.
function AnswerCard({ message }: { message: Message }) {
  const [flipped, setFlipped] = useState(false);
  const [height, setHeight] = useState<number>();
  const front = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLDivElement>(null);

  // The card is as tall as the side being shown; CSS animates the change, so nothing jumps.
  useLayoutEffect(() => {
    const face = (flipped ? back : front).current;
    if (!face) return;
    const measure = () => setHeight(face.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(face);
    return () => observer.disconnect();
  }, [flipped]);

  const steps = message.steps ?? [];
  const find = (key: string) => steps.find((step) => step.key === key);
  const search = find('search');
  const sources = message.sources ?? [];
  const seconds = (Math.max(...steps.map((step) => step.ms)) / 1000).toFixed(1);

  const rows: { icon: string; label: string; value: ReactNode }[] = [
    { icon: 'memory', label: 'Memory', value: find('memory')?.detail ?? 'Not recorded' },
    {
      icon: 'search',
      label: 'Search',
      value: search ? (
        <>
          {search.started && search.started !== search.detail && <span className="how-line">{search.started}</span>}
          <span className="how-line">{search.detail}</span>
        </>
      ) : (
        'No web search was needed'
      ),
    },
    {
      icon: 'sources',
      label: 'Sources',
      value: sources.length ? (
        <ul className="sources">
          {sources.map((source, i) => (
            <li key={i}>
              <a href={source.url} target="_blank" rel="noreferrer" title={source.title}>
                {siteName(source.url)}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        'None'
      ),
    },
    { icon: 'time', label: 'Time', value: `${seconds} s` },
  ];

  return (
    <div className={flipped ? 'answer-card flipped' : 'answer-card'} style={{ height }}>
      <div className="answer-inner">
        {/* Only the side facing the user can be reached by keyboard and screen readers (inert). */}
        <div ref={front} className="answer-face front" inert={flipped} aria-hidden={flipped}>
          <Markdown text={message.content} />
        </div>
        <div ref={back} className="answer-face back" inert={!flipped} aria-hidden={!flipped}>
          <h3>How I answered</h3>
          <dl className="how">
            {rows.map((row) => (
              <div key={row.label} className="how-row">
                <dt>
                  <Icon name={row.icon} />
                  {row.label}
                </dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <button
        className="flip-button"
        onClick={() => setFlipped(!flipped)}
        aria-label={flipped ? 'Show the answer' : 'Show how I answered'}
        title={flipped ? 'Show the answer' : 'Show how I answered'}
      >
        <Icon name="rotate" />
      </button>
    </div>
  );
}

// Turns markdown text (**bold**, lists, links, tables) into real formatting.
function Markdown({ text }: { text: string }) {
  // Wrap each verdict in inline code with the marker; the `code` renderer below turns it into a badge.
  // Code blocks (```...```) are left alone; odd parts of the split are the code blocks.
  const marked = text
    .split(/(```[\s\S]*?```)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/`(UNCHANGED|CHANGED|COULD NOT VERIFY)`/g, '$1') // the model already used backticks
            .replace(VERDICTS, (word) => '`' + MARK + word + '`'),
    )
    .join('');
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
        code: ({ node, children, ...props }) => {
          const value = String(children);
          if (value.startsWith(MARK) && BADGE_CLASS[value.slice(1)]) {
            return <span className={BADGE_CLASS[value.slice(1)]}>{value.slice(1)}</span>;
          }
          return <code {...props}>{children}</code>;
        },
      }}
    >
      {marked}
    </ReactMarkdown>
  );
}

export default function ChatPage() {
  const [past, setPast] = useState<Message[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [openItem, setOpenItem] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [dark, setDark] = useState(false);
  const [accent, setAccent] = useState('blue');
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [switchMoved, setSwitchMoved] = useState(false); // only slide the switch after a click, not on page load
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerFrom = useRef<number | null>(null); // where the input was before the first message
  const welcome = messages.length === 0;

  // When the first message is sent, the input jumps from the centre to the bottom.
  // Slide it there instead: start it at its old spot and animate it into place (350ms).
  useLayoutEffect(() => {
    const el = composerRef.current;
    const from = composerFrom.current;
    composerFrom.current = null;
    if (welcome || !el || from === null) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const distance = from - el.getBoundingClientRect().top;
    if (distance) {
      el.animate([{ transform: `translateY(${distance}px)` }, { transform: 'none' }], {
        duration: 350,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      });
    }
  }, [welcome]);

  // On first load: use the saved theme, or the system setting if nothing is saved.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('theme');
    } catch {}
    setDark(saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);

    // The accent colour: the saved one, or blue.
    let savedAccent: string | null = null;
    try {
      savedAccent = localStorage.getItem('accent');
    } catch {}
    if (ACCENTS.some((a) => a.id === savedAccent)) setAccent(savedAccent!);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
  }, [accent]);

  function chooseAccent(id: string) {
    setAccent(id);
    setPickerOpen(false);
    try {
      localStorage.setItem('accent', id);
    } catch {}
  }

  // Escape closes the colour picker, or else the history panel.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (pickerOpen) setPickerOpen(false);
      else if (showHistory) setShowHistory(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pickerOpen, showHistory]);

  // A click anywhere outside the colour picker closes it.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [pickerOpen]);

  // Tell the CSS which colours to use.
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    setSwitchMoved(true);
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {}
  }

  useEffect(() => {
    fetch('/api/history')
      .then((response) => response.json())
      .then((data) => setPast(data.messages));
  }, []);

  // Keep the newest message in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  // Everything ever said: older messages from the database, then this visit's messages.
  const all = [...past, ...messages];

  // Build the history list: every question, grouped by day, with its answer.
  const days: { day: string; items: { index: number; question: Message; answer?: Message }[] }[] = [];
  all.forEach((message, index) => {
    if (message.role !== 'user' || !message.createdAt) return;
    const day = formatDay(message.createdAt);
    let group = days.find((d) => d.day === day);
    if (!group) {
      group = { day, items: [] };
      days.push(group);
    }
    const next = all[index + 1];
    group.items.push({ index, question: message, answer: next?.role === 'assistant' ? next : undefined });
  });

  // `preset` is used by the example buttons; otherwise the typed text is sent.
  async function send(preset?: string) {
    const text = (preset ?? input).trim();
    if (!text || busy) return;

    if (welcome) composerFrom.current = composerRef.current?.getBoundingClientRect().top ?? null;
    const history: Message[] = [...messages, { role: 'user', content: text, createdAt: new Date().toISOString() }];
    let answer: Message = { role: 'assistant', content: '' };
    setMessages([...history, answer]);
    if (preset === undefined) setInput('');
    setBusy(true);
    textareaRef.current?.focus(); // keep typing in the same box, even after clicking an example

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, tzOffsetMinutes: -new Date().getTimezoneOffset() }),
      });
      if (!response.ok || !response.body) throw new Error('The server did not answer.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line);

          if (event.type === 'step') {
            // Same key = update that step; a new key = add it to the end.
            const { type, ...step } = event;
            const steps = answer.steps ?? [];
            const updated = steps.some((s) => s.key === step.key)
              ? steps.map((s) => (s.key === step.key ? { ...step, started: s.started } : s))
              : [...steps, { ...step, started: step.detail }];
            answer = { ...answer, steps: updated };
          }
          if (event.type === 'text') answer = { ...answer, content: answer.content + event.delta };
          if (event.type === 'error') answer = { ...answer, failed: true, content: answer.content || event.message };
          if (event.type === 'done') answer = { ...event.message, steps: answer.steps };

          setMessages([...history, answer]);
        }
      }
    } catch (error) {
      answer = { ...answer, failed: true, content: 'Could not reach the server. Is it still running?' };
      setMessages([...history, answer]);
    }

    setBusy(false);
  }

  return (
    <div className="app">
      {/* Floating controls instead of a top bar. */}
      <div className="float left">
        <button
          className="round"
          onClick={() => setShowHistory(!showHistory)}
          aria-label={showHistory ? 'Close history' : 'History'}
          title={showHistory ? 'Close history' : 'History'}
          aria-expanded={showHistory}
        >
          {/* A window with a side panel. The left third fills in while the history panel is open. */}
          <svg className="icon sidebar-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path className="sidebar-fill" d="M9 4H6a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h3z" />
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="M9 4v16" />
          </svg>
        </button>
      </div>

      <div className="float right">
        <div className="picker" ref={pickerRef}>
          <button
            className="round"
            onClick={() => setPickerOpen(!pickerOpen)}
            aria-label="Colour"
            title="Colour"
            aria-expanded={pickerOpen}
          >
            <Icon name="palette" />
          </button>
          {pickerOpen && (
            <div className="swatches" role="group" aria-label="Accent colour">
              {ACCENTS.map((option) => (
                <button
                  key={option.id}
                  className={'swatch ' + option.id}
                  aria-label={option.label}
                  title={option.label}
                  aria-pressed={accent === option.id}
                  onClick={() => chooseAccent(option.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* A sliding switch: knob left with a sun = light, knob right with a moon = dark. */}
        <button
          className={switchMoved ? 'switch animate' : 'switch'}
          role="switch"
          aria-checked={dark}
          aria-label="Dark mode"
          onClick={toggleTheme}
        >
          <span className="switch-knob">
            <Icon name={dark ? 'moon' : 'sun'} />
          </span>
        </button>
      </div>

      <aside className={showHistory ? 'panel open' : 'panel'}>
        <div className="panel-inner">
          <h2>History</h2>

          {days.length === 0 && <p className="panel-empty">No questions yet.</p>}

          {days.map((group) => (
            <div key={group.day} className="day">
              <p className="day-label">{group.day}</p>
              {group.items.map((item) => (
                <div key={item.index}>
                  <button
                    className={openItem === item.index ? 'item open' : 'item'}
                    onClick={() => setOpenItem(openItem === item.index ? null : item.index)}
                    title={item.question.content}
                  >
                    {item.question.content}
                  </button>

                  {openItem === item.index && (
                    <div className="item-detail">
                      <div className="item-time">{formatTime(item.question.createdAt!)}</div>
                      {item.answer ? <Markdown text={item.answer.content} /> : <i>No answer was saved for this question.</i>}
                      {item.answer && (
                        <button
                          className="recheck"
                          disabled={busy}
                          onClick={() => {
                            // Ask the agent to re-check this old answer, through the normal chat flow.
                            setShowHistory(false);
                            send(
                              `On ${formatLongDate(item.question.createdAt!)} I asked: "${item.question.content}" Is your answer still correct?`,
                            );
                          }}
                        >
                          <Icon name="rotate" />
                          Check again today
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <main className="chat">

        <section className="thread" hidden={welcome}>
          <div className="thread-inner">
            {messages.map((message, index) => {
              const writing = busy && index === messages.length - 1 && message.role === 'assistant';
              // A complete answer from this visit: shown as a card that can flip. History answers have no steps.
              const finished = message.role === 'assistant' && !writing && !message.failed && Boolean(message.steps?.length);
              return (
                <article key={index} className={`msg ${message.role}${message.failed ? ' failed' : ''}`}>
                  {writing && message.steps && message.steps.length > 0 && (
                    <ol className="steps">
                      {/* Finished steps, with a tick and the time. */}
                      {message.steps
                        .filter((step) => step.done)
                        .map((step) => (
                          <li key={step.key} className="step done">
                            <span className="step-icon" aria-hidden="true">
                              ✓
                            </span>
                            <span className="step-label">{shownStep(step).label}</span>
                            {shownStep(step).detail && <span className="step-detail">{shownStep(step).detail}</span>}
                            <span className="step-time">{(step.ms / 1000).toFixed(1)}s</span>
                          </li>
                        ))}
                      {/* The step running now: one row that stays in place, its label flips when the step changes. */}
                      {message.steps
                        .filter((step) => !step.done)
                        .slice(-1)
                        .map((step) => (
                          <li key="now" className="step running">
                            <span className="step-icon" aria-hidden="true" />
                            <span className="step-label">
                              <FlipText text={shownStep(step).label} />
                            </span>
                            {shownStep(step).detail && <span className="step-detail">{shownStep(step).detail}</span>}
                          </li>
                        ))}
                    </ol>
                  )}

                  {message.content &&
                    (finished ? (
                      <AnswerCard message={message} />
                    ) : (
                      <div className={writing ? 'bubble writing' : 'bubble'}>
                        {message.role === 'assistant' ? <Markdown text={message.content} /> : message.content}
                      </div>
                    ))}

                  {message.sources && message.sources.length > 0 && (
                    <ul className="sources">
                      {message.sources.map((source, i) => (
                        <li key={i} style={{ animationDelay: `${i * 60}ms` }}>
                          <a href={source.url} target="_blank" rel="noreferrer" title={source.title}>
                            {siteName(source.url)}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}

                  {message.createdAt && <time className="when">{formatTime(message.createdAt)}</time>}
                </article>
              );
            })}
            <div ref={bottomRef} />
          </div>
        </section>

        {/* The same input element is used on the welcome screen (centre) and in the chat (bottom),
            so typed text and focus are never lost. */}
        <div
          className={welcome ? 'stage welcome' : 'stage'}
          onMouseMove={
            welcome
              ? (event) => {
                  // Move the soft glow to follow the mouse.
                  const box = event.currentTarget.getBoundingClientRect();
                  event.currentTarget.style.setProperty('--mx', `${event.clientX - box.left}px`);
                  event.currentTarget.style.setProperty('--my', `${event.clientY - box.top}px`);
                }
              : undefined
          }
        >
          {welcome && (
            <div className="welcome-top">
              <p className="brand">Recall</p>

              <h2>
                {HEADLINE.map((word, i) => (
                  <span key={i} className="word" style={{ animationDelay: `${150 + i * 90}ms` }}>
                    {word}{' '}
                  </span>
                ))}
              </h2>

              <p>A search agent that remembers what you asked and when, so you can check later whether the answer still holds.</p>
            </div>
          )}

          <div className="composer" ref={composerRef}>
            <div className="composer-inner">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
                placeholder="Ask anything…"
                aria-label="Your question"
                rows={1}
                autoFocus
              />
              <button onClick={() => send()} disabled={busy || !input.trim()}>
                {busy ? 'Working' : 'Send'}
              </button>
            </div>
          </div>

          {welcome && (
            <div className="examples">
              {EXAMPLES.map((example, i) => (
                <button
                  key={example.question}
                  className="example"
                  style={{ animationDelay: `${800 + i * 70}ms` }}
                  onClick={() => send(example.question)}
                  disabled={busy}
                >
                  {/* Two sides stacked in the same spot; the inner part turns over on hover or keyboard focus. */}
                  <span className="example-inner">
                    <span className="example-face front">{example.question}</span>
                    <span className="example-face back" aria-hidden="true">
                      {example.plan}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}