import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { RealtimeClient } from '@supabase/realtime-js';
import DotGrid from './DotGrid';
import './style.css';

type Player = { name: string; points: number };
type Column = {
  name: string; resource: string; dataset: string; url: string;
  description: string | null; examples: string[];
};
type Card = { id: string; columns: [Column, Column] };
type Rank = { name: string; rank: number; points: number };
type Leaderboard = {
  asOf: string;
  top: Rank[];
  you: (Omit<Rank, 'rank'> & { rank: number | null; livePoints: number }) | null;
};

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const apiOrigin = import.meta.env.MODE === 'pages'
  ? new URL(import.meta.env.VITE_SUPABASE_URL).origin
  : '';
const sessionKey = 'odd-scoring:session:' + apiOrigin;
let browserToken: string | null = null;
if (apiOrigin) {
  try { browserToken = localStorage.getItem(sessionKey); } catch { /* Storage may be disabled. */ }
}

function rememberToken(token: string | null) {
  browserToken = token;
  try {
    if (token) localStorage.setItem(sessionKey, token);
    else localStorage.removeItem(sessionKey);
  } catch { /* Keep the current session in memory. */ }
}

async function api<T>(route: string, body?: Record<string, unknown>): Promise<T> {
  const response = apiOrigin
    ? await fetch(apiOrigin + '/rest/v1/rpc/odd_scoring_play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify({ action: route === 'session' && body ? 'select' : route,
        session_token: browserToken, payload: body ?? {} }),
      credentials: 'omit',
    })
    : await fetch('/api/' + route, body && {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    const detail = apiOrigin && response.status < 500 ? failure.message : failure.error;
    throw new RequestError(detail || 'Could not complete the request. Try again.', response.status);
  }
  const data = await response.json();
  if (apiOrigin && route === 'session') {
    if (data === null || typeof data.token === 'string') rememberToken(data?.token ?? null);
  }
  return data as T;
}

function message(error: unknown) {
  return error instanceof RequestError ? error.message : 'Could not connect. Try again.';
}

function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} aria-labelledby="modal-title" onCancel={event => {
    event.preventDefault();
    close();
  }}>
    <div className="dialog-head">
      <h2 id="modal-title">{title}</h2>
      <button className="close" type="button" aria-label="Close" onClick={close}>×</button>
    </div>
    {children}
  </dialog>;
}

function useLeaderboard(enabled: boolean, playerName?: string) {
  const [board, setBoard] = useState<Leaderboard>();
  const [error, setError] = useState('');
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let connected = false;
    let loading = false;
    let queued = false;
    function load() {
      if (!active) return;
      if (loading) {
        queued = true;
        return;
      }
      loading = true;
      void api<Leaderboard>('leaderboard').then(next => {
        if (!active) return;
        setBoard(next);
        setError('');
      }).catch(failure => {
        if (active) setError(message(failure));
      }).finally(() => {
        loading = false;
        if (queued) {
          queued = false;
          load();
        }
      });
    }

    refresh.current = load;
    load();
    const timer = window.setInterval(() => { if (!connected) load(); }, 5000);
    const realtime = apiOrigin ? new RealtimeClient(apiOrigin.replace(/^http/, 'ws') + '/realtime/v1', {
      params: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
    }) : undefined;
    const channel = realtime?.channel('odd-scoring-leaderboard', { config: { private: false } })
      .on('broadcast', { event: 'changed' }, load)
      .subscribe(status => {
        connected = status === 'SUBSCRIBED';
        if (connected) load();
      });
    return () => {
      active = false;
      window.clearInterval(timer);
      if (channel) void realtime?.removeChannel(channel);
    };
  }, [enabled, playerName]);
  return { board, error, refresh: () => refresh.current() };
}

function RankPanel({ close, board, error, refresh }: {
  close: () => void;
  board: Leaderboard | undefined;
  error: string;
  refresh: () => void;
}) {
  return <Modal title="Leaderboard" close={close}>
    {error && <p role="alert">{error} <button onClick={refresh}>Retry</button></p>}
    {!board && !error && <p role="status">Loading rankings…</p>}
    {board && <>
      {board.you && <div className="your-rank">
        <div><span>Your rank</span><strong>{board.you.rank === null ? 'Unranked' : '#' + board.you.rank}</strong></div>
        <div><span>Total answers</span><strong>{board.you.points.toLocaleString()}</strong></div>
      </div>}
      {board.top.length === 0 ? <p>No ranked players yet.</p> :
        <table>
          <thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Points</th></tr></thead>
          <tbody>{board.top.map(row => <tr key={row.name} className={row.name === board.you?.name ? 'current' : ''}>
            <td>{row.rank}</td><td>{row.name}</td><td>{row.points.toLocaleString()}</td>
          </tr>)}</tbody>
        </table>}
    </>}
  </Modal>;
}

function Record({ column, side }: { column: Column; side: string }) {
  return <article className="record">
    <div className="record-label"><span aria-hidden="true">{side}</span> Column {side}</div>
    <h2>{column.name}</h2>
    <div className="record-details">
      <dl className="record-source">
        <dt>Dataset</dt>
        <dd><a href={column.url} target="_blank" rel="noreferrer">{column.dataset}<span aria-hidden="true">&nbsp;↗</span>
          <span className="sr-only"> (opens in a new tab)</span></a></dd>
        {column.resource && column.resource !== column.dataset && <>
          <dt>Resource</dt>
          <dd>{column.resource}</dd>
        </>}
      </dl>
      {column.examples.length > 0 && <table className="examples">
        <caption>Example values</caption>
        <tbody>{column.examples.map((value, i) =>
          <tr key={i}><td><code>{value}</code></td></tr>)}</tbody>
      </table>}
      {column.description && <details open className="dataset-description">
        <summary>Dataset description</summary>
        <p>{column.description}</p>
      </details>}
    </div>
  </article>;
}

function Confetti({ x, y }: { x: number; y: number }) {
  return <span className="confetti" style={{ left: x, top: y }} aria-hidden="true">
    {Array.from({ length: 14 }, (_, i) => <i key={i} style={{
      '--x': ((i - 6.5) * 12) + 'px',
      '--y': (-36 - (i % 4) * 15) + 'px',
      '--spin': (i % 2 ? 1 : -1) * (60 + i * 34) + 'deg',
      '--color': ['var(--accent)', 'var(--bar)', '#e7a72f'][i % 3],
    } as React.CSSProperties} />)}
  </span>;
}

function App() {
  const [player, setPlayer] = useState<Player | null>();
  const [card, setCard] = useState<Card | null>();
  const [name, setName] = useState('');
  const [taken, setTaken] = useState(false);
  const [leaderboard, setLeaderboard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [burst, setBurst] = useState<{ id: number; x: number; y: number }>();
  const [awaitingNext, setAwaitingNext] = useState(false);
  const [promotion, setPromotion] = useState<{ rank: number }>();
  const nameInput = useRef<HTMLInputElement>(null);
  const voteInProgress = useRef(false);
  const standings = useLeaderboard(!!player || leaderboard, player?.name);
  const yourStanding = standings.board?.you?.name === player?.name ? standings.board?.you : undefined;
  const yourRank = yourStanding?.rank;
  const answerCount = Math.max(player?.points ?? 0, yourStanding?.points ?? 0);

  useEffect(() => {
    if (!promotion) return;
    const timer = window.setTimeout(() => setPromotion(undefined), 5000);
    return () => window.clearTimeout(timer);
  }, [promotion]);

  async function getCard() {
    setError('');
    try {
      setCard(await api<Card | null>('card'));
      setAwaitingNext(false);
    } catch (error) {
      setError(message(error));
    }
  }

  async function restore() {
    setError('');
    try {
      const previous = await api<Player | null>('session');
      setPlayer(previous);
      if (previous) await getCard();
    } catch (error) {
      setError(message(error));
    }
  }
  useEffect(() => { void restore(); }, []);

  async function select(joinExisting = false) {
    setError('');
    setBusy(true);
    try {
      const next = await api<Player>('session', { name, joinExisting });
      setTaken(false);
      setPlayer(next);
      await getCard();
    } catch (error) {
      if (error instanceof RequestError && error.status === 409) setTaken(true);
      else setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  async function vote(answer: boolean, button: HTMLButtonElement) {
    if (!card || !player || voteInProgress.current || awaitingNext) return;
    voteInProgress.current = true;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const result = await api<{ points: number; answer: boolean; promotion: number | null }>(
        'answer', { cardId: card.id, answer });
      setPlayer({ ...player, points: result.points });
      if (result.promotion != null) setPromotion({ rank: result.promotion });
      standings.refresh();
      setNotice(result.answer === answer ? 'Answer saved.' : 'This card was already answered.');
      setAwaitingNext(true);
      const rect = button.getBoundingClientRect();
      setBurst({ id: Date.now(), x: rect.left + rect.width / 2,
        y: Math.max(24, Math.min(window.innerHeight - 10, rect.top + rect.height / 2)) });
      await getCard();
    } catch (error) {
      setError(message(error));
    } finally {
      voteInProgress.current = false;
      setBusy(false);
    }
  }

  function submitName(event: FormEvent) {
    event.preventDefault();
    if (!busy) void select();
  }

  function closeTaken() {
    if (busy) return;
    setTaken(false);
    setError('');
    requestAnimationFrame(() => nameInput.current?.focus());
  }

  return <>
    <DotGrid />
    <header className="top">
      <div className="top-inner">
        <div className="brand"><span className="brand-mark" aria-hidden="true" /> Join Check</div>
        <button type="button" className="outline" onClick={() => setLeaderboard(true)}>Leaderboard</button>
      </div>
    </header>
    <main>
      {player === null ? <section className="intro" aria-labelledby="intro-title">
        <h1 id="intro-title">Should these columns join?</h1>
        <p>Help audit Toronto’s Open Data joins. Review two columns at a time and earn a point for each answer.</p>
        <form onSubmit={submitName}>
          <label htmlFor="username">Username</label>
          <div className="name-row">
            <input id="username" required maxLength={24} autoComplete="username" ref={nameInput}
              value={name} onChange={event => setName(event.target.value)} />
            <button type="submit" className="primary" disabled={busy}>Start reviewing</button>
          </div>
        </form>
      </section> : player ? <>
        <div className="player-line"><span>{player.name}</span>
          <div className="player-stats">
            <span>{yourRank === undefined ? 'Rank —' : yourRank === null ? 'Unranked' : <>Rank <strong>#{yourRank}</strong></>}</span>
            <span><strong>{answerCount.toLocaleString()}</strong> {answerCount === 1 ? 'answer' : 'answers'}</span>
          </div>
        </div>
        <h1 className="review-question">Do these columns represent the same kind of thing?</h1>
        <p className="hint">Read the dataset descriptions and examples. Vote <strong>Yes</strong> if both
          columns refer to the same kind of entity or attribute, or <strong>No</strong> if they mean different things.</p>
        {card && <>
          <div className="pair" key={card.id}>
            <Record column={card.columns[0]} side="A" />
            <Record column={card.columns[1]} side="B" />
          </div>
          <div className="vote" role="group" aria-label="Vote on this pair">
            <button type="button" className="outline" aria-disabled={busy || awaitingNext}
              onClick={event => void vote(false, event.currentTarget)}>
              <span aria-hidden="true">×</span> No
            </button>
            <button type="button" className="outline" aria-disabled={busy || awaitingNext}
              onClick={event => void vote(true, event.currentTarget)}>
              <span aria-hidden="true">✓</span> Yes
            </button>
          </div>
        </>}
        {card === null && <p className="empty">You’ve answered every pair in this dataset snapshot.</p>}
        {card === undefined && !error && <p role="status">Loading your next pair…</p>}
        <span className="sr-only" role="status">{notice}</span>
        <div role="status">{promotion && !error && <div className="rank-promotion">
          You reached <strong>#{promotion.rank}</strong> on the leaderboard!
        </div>}</div>
        {burst && <Confetti key={burst.id} x={burst.x} y={burst.y} />}
      </> : !error && <p role="status">Loading Join Check…</p>}
      {error && !taken && <p className={player && card ? 'error vote-error' : 'error'} role="alert">{error}{player === undefined
        ? <> <button onClick={() => void restore()}>Retry</button></>
        : player && (card === undefined || awaitingNext) &&
          <> <button onClick={() => void getCard()}>Retry</button></>}</p>}
    </main>
    {taken && <Modal title="Use this username?" close={closeTaken}>
      <p>This username is already taken, so your score will be added to an existing individual. Are you sure?</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="outline" disabled={busy} onClick={closeTaken}>No</button>
        <button className="primary" disabled={busy} onClick={() => void select(true)}>Yes</button>
      </div>
    </Modal>}
    {leaderboard && <RankPanel {...standings} close={() => setLeaderboard(false)} />}
  </>;
}

createRoot(document.getElementById('root')!).render(<App />);
