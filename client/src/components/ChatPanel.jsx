import { useRef, useEffect, useState } from 'react'
import { Send, RotateCcw, ChevronDown, ChevronUp, Database, AlertCircle, Sparkles } from 'lucide-react'

const SUGGESTED = [
  'Which products are associated with the highest number of billing documents?',
  'Trace the full flow of the latest billing document',
  'Find sales orders that were delivered but never billed',
  'Show top 5 customers by total order value',
  'Which deliveries are still pending?',
  'Show all payments made via NEFT this year',
]

function renderMarkdown(text) {
  if (!text) return ''
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:4px;font-family:var(--font-mono);font-size:11px">$1</code>')
}

function SqlDrawer({ sql }) {
  const [open, setOpen] = useState(false)
  if (!sql) return null
  return (
    <div style={styles.sqlDrawer}>
      <button onClick={() => setOpen(v => !v)} style={styles.sqlToggle}>
        <Database size={12} style={{ marginRight: 5 }} />
        SQL query
        {open ? <ChevronUp size={12} style={{ marginLeft: 'auto' }} /> : <ChevronDown size={12} style={{ marginLeft: 'auto' }} />}
      </button>
      {open && (
        <pre style={styles.sqlCode}>{sql}</pre>
      )}
    </div>
  )
}

function ResultsTable({ results }) {
  const [open, setOpen] = useState(false)
  if (!results || results.length === 0) return null
  const cols = Object.keys(results[0])
  return (
    <div style={styles.sqlDrawer}>
      <button onClick={() => setOpen(v => !v)} style={styles.sqlToggle}>
        <Database size={12} style={{ marginRight: 5 }} />
        {results.length} row{results.length !== 1 ? 's' : ''} returned
        {open ? <ChevronUp size={12} style={{ marginLeft: 'auto' }} /> : <ChevronDown size={12} style={{ marginLeft: 'auto' }} />}
      </button>
      {open && (
        <div style={{ overflowX: 'auto', maxHeight: 220 }}>
          <table style={styles.table}>
            <thead>
              <tr>
                {cols.map(c => <th key={c} style={styles.th}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {results.slice(0, 20).map((row, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                  {cols.map(c => (
                    <td key={c} style={styles.td}>
                      {row[c] === null ? <span style={{ color: 'var(--text-muted)' }}>null</span> : String(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Message({ msg }) {
  const isUser = msg.role === 'user'

  if (isUser) {
    return (
      <div style={styles.userBubbleRow}>
        <div style={styles.userBubble}>{msg.content}</div>
        <div style={styles.avatar}>You</div>
      </div>
    )
  }

  return (
    <div style={styles.assistantRow}>
      <div style={styles.dodgeAvatar}>D</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Agent label */}
        <div style={styles.agentLabel}>
          <span style={{ color: 'var(--accent)', fontWeight: 500 }}>Dodge AI</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 6 }}>Graph Agent</span>
        </div>

        {/* Status */}
        {msg.streaming && msg.status && (
          <div style={styles.statusRow}>
            <div className="spinner" style={{ width: 12, height: 12, marginRight: 6, flexShrink: 0 }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{msg.status}</span>
          </div>
        )}

        {/* Blocked / off-topic */}
        {msg.blocked && (
          <div style={styles.blockedBanner}>
            <AlertCircle size={13} style={{ flexShrink: 0 }} />
            <span>{msg.content}</span>
          </div>
        )}

        {/* Answer text */}
        {!msg.blocked && msg.content && (
          <div
            style={styles.answerText}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
          />
        )}

        {/* Streaming cursor */}
        {msg.streaming && msg.content && !msg.status && (
          <span style={styles.cursor}>▋</span>
        )}

        {/* SQL + Results */}
        {!msg.streaming && (
          <>
            <SqlDrawer sql={msg.sql} />
            <ResultsTable results={msg.results} />
          </>
        )}
      </div>
    </div>
  )
}

export default function ChatPanel({ messages, input, setInput, onSend, isLoading, onClear }) {
  const bottomRef = useRef(null)
  const inputRef  = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <div style={{ fontWeight: 500, fontSize: 14 }}>Chat with Graph</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 1 }}>Order to Cash</div>
        </div>
        <button onClick={onClear} style={styles.clearBtn} title="Clear conversation">
          <RotateCcw size={13} />
        </button>
      </div>

      {/* Messages */}
      <div style={styles.messages}>
        {messages.map(msg => (
          <Message key={msg.id} msg={msg} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Suggested queries — only show before user sends first message */}
      {messages.length === 1 && (
        <div style={styles.suggestions}>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
            <Sparkles size={11} /> Try asking
          </div>
          {SUGGESTED.map((s, i) => (
            <button key={i} style={styles.suggestionBtn} onClick={() => onSend(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Status bar */}
      <div style={styles.statusBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: isLoading ? 'var(--amber)' : 'var(--green)',
            animation: isLoading ? 'pulse 1.2s ease infinite' : 'none',
          }} />
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
            {isLoading ? 'Dodge AI is thinking...' : 'Dodge AI is awaiting instructions.'}
          </span>
        </div>
      </div>

      {/* Input */}
      <div style={styles.inputRow}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Analyze anything"
          rows={1}
          disabled={isLoading}
          style={styles.textarea}
        />
        <button
          onClick={() => onSend()}
          disabled={isLoading || !input.trim()}
          style={{
            ...styles.sendBtn,
            opacity: isLoading || !input.trim() ? 0.4 : 1,
          }}
        >
          <Send size={15} />
        </button>
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
      `}</style>
    </div>
  )
}

const styles = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--bg-panel)',
    borderLeft: '1px solid var(--border)',
  },
  header: {
    padding: '14px 16px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
  },
  clearBtn: {
    background: 'none',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: '5px 7px',
    display: 'flex',
    alignItems: 'center',
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 16px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },
  userBubbleRow: {
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
    gap: 10,
  },
  userBubble: {
    background: 'var(--accent)',
    color: '#fff',
    borderRadius: '14px 14px 4px 14px',
    padding: '10px 14px',
    fontSize: 13,
    maxWidth: '80%',
    lineHeight: 1.5,
  },
  avatar: {
    width: 28, height: 28,
    borderRadius: '50%',
    background: 'var(--bg-card)',
    border: '1px solid var(--border-light)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
    color: 'var(--text-muted)',
    flexShrink: 0,
  },
  assistantRow: {
    display: 'flex',
    gap: 10,
    alignItems: 'flex-start',
  },
  dodgeAvatar: {
    width: 28, height: 28,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, var(--accent), var(--purple))',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 600,
    color: '#fff',
    flexShrink: 0,
  },
  agentLabel: {
    marginBottom: 6,
    fontSize: 12,
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    marginBottom: 4,
  },
  blockedBanner: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    background: 'rgba(248,113,113,0.08)',
    border: '1px solid rgba(248,113,113,0.2)',
    borderRadius: 8,
    padding: '10px 12px',
    color: '#f87171',
    fontSize: 13,
    lineHeight: 1.5,
  },
  answerText: {
    color: 'var(--text-secondary)',
    fontSize: 13,
    lineHeight: 1.65,
  },
  cursor: {
    color: 'var(--accent)',
    animation: 'blink 1s step-end infinite',
    fontSize: 14,
  },
  sqlDrawer: {
    marginTop: 10,
    borderRadius: 8,
    overflow: 'hidden',
    border: '1px solid var(--border)',
  },
  sqlToggle: {
    width: '100%',
    background: 'var(--bg-card)',
    border: 'none',
    padding: '7px 10px',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    fontSize: 11,
    fontFamily: 'var(--font-sans)',
    display: 'flex',
    alignItems: 'center',
  },
  sqlCode: {
    background: 'var(--bg-base)',
    padding: '12px',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: '#a3e635',
    overflowX: 'auto',
    maxHeight: 180,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    borderTop: '1px solid var(--border)',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
  },
  th: {
    padding: '6px 10px',
    background: 'var(--bg-card)',
    color: 'var(--text-muted)',
    textAlign: 'left',
    borderBottom: '1px solid var(--border)',
    fontFamily: 'var(--font-sans)',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '5px 10px',
    color: 'var(--text-secondary)',
    borderBottom: '1px solid rgba(255,255,255,0.03)',
    maxWidth: 200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  suggestions: {
    padding: '0 16px 12px',
    borderTop: '1px solid var(--border)',
    paddingTop: 12,
  },
  suggestionBtn: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '8px 12px',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: 12,
    marginBottom: 5,
    fontFamily: 'var(--font-sans)',
    lineHeight: 1.4,
    transition: 'border-color 0.15s, background 0.15s',
  },
  statusBar: {
    padding: '8px 16px',
    borderTop: '1px solid var(--border)',
    flexShrink: 0,
  },
  inputRow: {
    padding: '10px 14px',
    display: 'flex',
    gap: 8,
    alignItems: 'flex-end',
    borderTop: '1px solid var(--border)',
    flexShrink: 0,
  },
  textarea: {
    flex: 1,
    background: 'var(--bg-input)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '10px 14px',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    resize: 'none',
    outline: 'none',
    lineHeight: 1.5,
    maxHeight: 120,
    overflowY: 'auto',
  },
  sendBtn: {
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 10,
    width: 38, height: 38,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'opacity 0.15s',
  },
}
