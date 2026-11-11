'use client';

import { useEffect, useState } from 'react';

type Source = { title: string; url: string };
type Message = {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  createdAt?: string;
  note?: string;
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

export default function ChatPage() {
  const [past, setPast] = useState<Message[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [openItem, setOpenItem] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    fetch('/api/history')
      .then((response) => response.json())
      .then((data) => setPast(data.messages));
  }, []);

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

  async function send() {
    if (!input.trim() || busy) return;

    const history: Message[] = [...messages, { role: 'user', content: input, createdAt: new Date().toISOString() }];
    let answer: Message = { role: 'assistant', content: '' };
    setMessages([...history, answer]);
    setInput('');
    setBusy(true);
    setStatus('Thinking');

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: input, tzOffsetMinutes: -new Date().getTimezoneOffset() }),
    });

    const reader = response.body!.getReader();
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

        if (event.type === 'status') setStatus(event.text);
        if (event.type === 'text') {
          setStatus('');
          answer = { ...answer, content: answer.content + event.delta };
        }
        if (event.type === 'error') answer = { ...answer, content: 'Error: ' + event.message };
        if (event.type === 'memory') answer = { ...answer, note: event.note };
        if (event.type === 'done') answer = { ...event.message, note: answer.note };
        setMessages([...history, answer]);
      }
    }

    setStatus('');
    setBusy(false);
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif' }}>
      <aside
        style={{
          width: showHistory ? 320 : 0,
          transition: 'width 0.25s ease',
          overflow: 'hidden',
          flexShrink: 0,
          borderRight: showHistory ? '1px solid #ddd' : 'none',
          background: '#f7f7f5',
        }}
      >
        <div style={{ width: 320, height: '100%', overflowY: 'auto', padding: 16, boxSizing: 'border-box' }}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>History</h2>

          {days.length === 0 && <p style={{ color: 'gray', fontSize: 14 }}>No questions yet.</p>}

          {days.map((group) => (
            <div key={group.day} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: 'gray', marginBottom: 4 }}>{group.day}</div>
              {group.items.map((item) => (
                <div key={item.index}>
                  <button
                    onClick={() => setOpenItem(openItem === item.index ? null : item.index)}
                    title={item.question.content}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 8px',
                      marginBottom: 2,
                      border: 'none',
                      borderRadius: 6,
                      background: openItem === item.index ? '#e6e6e1' : 'transparent',
                      cursor: 'pointer',
                      fontSize: 14,
                      whiteSpace: openItem === item.index ? 'normal' : 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {item.question.content}
                  </button>

                  {openItem === item.index && (
                    <div style={{ fontSize: 13, padding: '4px 8px 10px', whiteSpace: 'pre-wrap' }}>
                      <div style={{ color: 'gray', fontSize: 11, marginBottom: 4 }}>
                        {formatTime(item.question.createdAt!)}
                      </div>
                      {item.answer ? item.answer.content : <i>No answer was saved for this question.</i>}
                      {item.answer?.sources?.map((source, i) => (
                        <a key={i} href={source.url} target="_blank" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                          {source.title}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <main style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 600, margin: '0 auto', padding: '24px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => setShowHistory(!showHistory)} style={{ padding: '6px 10px', cursor: 'pointer' }}>
              {showHistory ? 'Hide history' : 'Show history'}
            </button>
            <h1 style={{ margin: 0 }}>Recall</h1>
          </div>

          <div style={{ marginTop: 24 }}>
            {messages.length === 0 && <p style={{ color: 'gray' }}>Ask anything. Your past questions are in the history panel.</p>}
            {messages.map((message, index) => (
                 <div key={index} style={{ marginBottom: 16 }}>
                {message.note && <small style={{ color: 'teal' }}>{message.note}</small>}
                <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                  <b>{message.role === 'user' ? 'You' : 'Agent'}:</b> {message.content}
                </p>
                {message.sources?.map((source, i) => (
                  <a key={i} href={source.url} target="_blank" style={{ display: 'block', fontSize: 12 }}>
                    {source.title}
                  </a>
                ))}
                {message.createdAt && <small style={{ color: 'gray' }}>{formatTime(message.createdAt)}</small>}
              </div>
            ))}
          </div>

          {status && <p style={{ color: 'gray' }}>{status}…</p>}

          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && send()}
            placeholder="Type and press Enter"
            disabled={busy}
            style={{ width: '100%', padding: 8, boxSizing: 'border-box' }}
          />
        </div>
      </main>
    </div>
  );
}