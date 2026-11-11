import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkMoveLinks, type Annotation } from './annotations';
export type { Annotation } from './annotations';
type Message = { role: 'user' | 'assistant'; text: string; fen: string; arrows: Annotation[]; error?: string };
type MoveTurn = { id: number; fen: string; moves: string[] };
export function Chat({ playerColor, moveTurn, fen, moves, setArrows, setActive }: { playerColor: 'white' | 'black'; moveTurn: MoveTurn | null; fen: string; moves: string[]; setArrows: (fen: string, arrows: Annotation[]) => void; setActive: (id: string | null) => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [usage, setUsage] = useState({ session: { tokens: 0, cost: 0 }, lifetime: { tokens: 0, cost: 0 } });
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/api/usage', { signal: abort.signal }).then(r => r.ok ? r.json() : Promise.reject()).then(data => setUsage(previous => ({ ...previous, lifetime: data.lifetime }))).catch(() => {});
    return () => abort.abort();
  }, []);
  const usageLabel = (value: { tokens: number; cost: number }) => `${value.tokens.toLocaleString()} tok · $${value.cost.toFixed(4)}`;
  const [input, setInput] = useState(''); const [busy, setBusy] = useState(false); const [status, setStatus] = useState('');
  const [queue, setQueue] = useState<MoveTurn[]>([]);
  const lastMove = useRef(0);
  const running = useRef(false);
  useEffect(() => {
    if (moveTurn && moveTurn.id > lastMove.current) { lastMove.current = moveTurn.id; setQueue(previous => [...previous, moveTurn]); }
  }, [moveTurn]);
  useEffect(() => {
    if (!busy && queue.length && !running.current) {
      const [next, ...rest] = queue; setQueue(rest); void submit(next);
    }
  }, [busy, queue]);
  const conversation = useRef<string | undefined>(undefined); const controller = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const scrollLatest = () => { follow.current = true; setShowLatest(false); const list = listRef.current; if (list) list.scrollTop = list.scrollHeight; };
  useLayoutEffect(() => { if (follow.current) scrollLatest(); else setShowLatest(true); }, [messages, status]);
  useEffect(() => {
    const observer = new ResizeObserver(() => { if (follow.current) scrollLatest(); });
    if (listRef.current) observer.observe(listRef.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const field = inputRef.current;
    if (field) { field.style.height = 'auto'; field.style.height = `${Math.min(field.scrollHeight, 110)}px`; }
  }, [input]);
  useEffect(() => {
    const resumeTyping = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1 || target.closest('input, textarea, select, [contenteditable="true"]') || window.getSelection()?.toString()) return;
      // Preserve native Space activation on buttons and links.
      if (event.key === ' ' && target.closest('button, a')) return;
      event.preventDefault(); inputRef.current?.focus(); setInput(previous => (previous + event.key).slice(0, 8000));
    };
    document.addEventListener('keydown', resumeTyping);
    return () => document.removeEventListener('keydown', resumeTyping);
  }, []);
  async function submit(automatic?: MoveTurn) {
    if (running.current || (!automatic && (!input.trim() || queue.length > 0))) return;
    running.current = true;
    const question = automatic ? `The latest move was ${automatic.moves.at(-1)}. Identify which side played it from the history, then briefly review the move and current position using Stockfish. Highlight one useful idea with arrows when appropriate.` : input.trim();
    const snapshot = automatic?.fen ?? fen;
    const snapshotMoves = automatic?.moves ?? moves;
    follow.current = true;
    if (!automatic) { setInput(''); inputRef.current?.focus(); }
    setBusy(true); setStatus('Thinking…');
    setArrows(snapshot, []);
    setMessages(previous => [...previous, { role: 'user', text: automatic ? `Played ${automatic.moves.at(-1)}` : question, fen: snapshot, arrows: [] }, { role: 'assistant', text: '', fen: snapshot, arrows: [] }]);
    controller.current = new AbortController();
    const update = (patch: (m: Message) => Message) => setMessages(previous => previous.map((m,i) => i === previous.length - 1 ? patch(m) : m));
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: question, fen: snapshot, moves: snapshotMoves, playerColor, conversationId: conversation.current }), signal: controller.current.signal });
      if (!response.ok) {
        const body = await response.text();
        let message = body.trim() || `Request failed (HTTP ${response.status}).`;
        try { message = JSON.parse(body).message || message; } catch { /* Plain-text HTTP error. */ }
        throw new Error(message);
      }
      if (!response.body) throw new Error('Missing response stream');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.type === 'conversation') conversation.current = event.id;
          if (event.type === 'text') { update(m => ({ ...m, text: m.text + event.delta })); setStatus('Responding…'); }
          if (event.type === 'arrows') { update(m => ({ ...m, arrows: event.arrows })); setArrows(snapshot, event.arrows); }
          if (event.type === 'usage') setUsage({ session: event.session, lifetime: event.lifetime });
          if (event.type === 'status') setStatus(event.text);
          if (event.type === 'error') throw new Error(event.message);
        }
        if (done) break;
      }
    } catch (error) { update(m => ({ ...m, error: error instanceof Error && error.name === 'AbortError' ? 'Stopped.' : String(error) })); }
    finally { running.current = false; setBusy(false); setStatus(''); controller.current = null; }
  }
  return <aside aria-label="Companion chat"><div className="chat-heading"><h2>Companion</h2><span className="badge">Pi · Stockfish</span></div>
    <div className="usage-strip" title="USD estimates supplied by Pi, not subscription charges. Session means this conversation; lifetime totals are saved on this machine. Zero can mean pricing was unavailable."><span>Session {usageLabel(usage.session)}</span><span>All time {usageLabel(usage.lifetime)}</span><small>Est. USD · not a subscription bill</small></div>
    <div className="chat-messages" ref={listRef} onScroll={() => {
      const list = listRef.current;
      if (list) { follow.current = list.scrollHeight - list.clientHeight - list.scrollTop < 48; if (follow.current) setShowLatest(false); }
    }} aria-live="polite" aria-relevant="additions text">
      {!messages.length && <p className="muted">Ask about the position. I can check Stockfish and illustrate ideas with arrows. In analysis mode each move gets a brief review. Against Maia3, automatic coaching is optional; you can ask a question anytime.</p>}
      {messages.map((m,i) => <article key={i} className="message"><span className="eyebrow">{m.role === 'user' ? 'YOU' : 'COMPANION'}</span><Markdown remarkPlugins={[remarkGfm, [remarkMoveLinks, { fen: m.fen, arrows: m.arrows }]]} components={{ table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>, a: ({ href, children }) => {
        const id = href?.startsWith('#annotation-') ? href.slice(12) : href?.startsWith('#') ? href.slice(1) : null;
        const arrow = m.arrows.find(a => a.id === id);
        if (!arrow) return <span>{children}</span>;
        return <button className="move-reference" style={{ color: arrow.color }} disabled={m.fen !== fen}
          onMouseEnter={() => { setArrows(m.fen, m.arrows); setActive(arrow.id); }} onMouseLeave={() => setActive(null)}
          onFocus={() => { setArrows(m.fen, m.arrows); setActive(arrow.id); }} onBlur={() => setActive(null)}
          onClick={() => { setArrows(m.fen, m.arrows); setActive(arrow.id); }}>{children}</button>;
      } }}>{m.text}</Markdown>{m.error && <p role="alert" className="context-note">{m.error}</p>}{m.fen !== fen && <small className="muted">Discusses an earlier position.</small>}</article>)}
    </div>
    {showLatest && <button className="latest-button" onClick={scrollLatest}>↓ Latest</button>}
    <form className="chat-footer" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <label className="sr-only" htmlFor="chat">Message the companion</label>
      <textarea ref={inputRef} id="chat" rows={1} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
      }} maxLength={8000} placeholder="Ask about this position…" />
      <div className="composer-toolbar"><span role="status">{[status || 'Enter to send · Shift+Enter for newline', queue.length ? `${queue.length} review(s) queued` : ''].filter(Boolean).join(' · ')}</span>{busy ? <button type="button" onClick={() => controller.current?.abort()}>Stop</button> : <button disabled={!input.trim() || queue.length > 0} type="submit">Send ↑</button>}</div>
    </form>
  </aside>;
}
