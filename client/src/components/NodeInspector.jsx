import { useState, useEffect } from 'react'
import { X, Link2, ExternalLink } from 'lucide-react'

const TYPE_LABEL = {
  customers:         'Customer',
  sales_orders:      'Sales Order',
  sales_order_items: 'SO Item',
  products:          'Product',
  plants:            'Plant',
  addresses:         'Address',
  deliveries:        'Delivery',
  billing_docs:      'Billing Document',
  journal_entries:   'Journal Entry',
  payments:          'Payment',
}

const TYPE_COLOR = {
  customers:         '#7c6af7',
  sales_orders:      '#4f7df3',
  sales_order_items: '#3b6fd4',
  products:          '#a3e635',
  plants:            '#94a3b8',
  addresses:         '#64748b',
  deliveries:        '#2dd4bf',
  billing_docs:      '#f59e0b',
  journal_entries:   '#f97316',
  payments:          '#34d399',
}

// Fields to always hide in the metadata display
const HIDDEN_FIELDS = new Set(['id', 'label', 'nodeType', 'color', 'x', 'y', 'vx', 'vy', 'index', 'fx', 'fy', 'connections'])

function formatValue(key, value) {
  if (value === null || value === undefined) return <span style={{ color: 'var(--text-muted)' }}>—</span>
  if (typeof value === 'number') {
    if (key.includes('amount') || key.includes('value') || key.includes('price')) {
      return <span style={{ color: '#34d399', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        ₹{parseFloat(value).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
      </span>
    }
    return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{value.toLocaleString()}</span>
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      return <span style={{ color: 'var(--amber)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        {new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
      </span>
    }
    if (['COMPLETED', 'PAID', 'ACTIVE'].includes(value)) {
      return <span style={{ ...styles.badge, background: 'rgba(52,211,153,0.15)', color: '#34d399', border: '1px solid rgba(52,211,153,0.3)' }}>{value}</span>
    }
    if (['CANCELLED', 'FAILED', 'REJECTED'].includes(value)) {
      return <span style={{ ...styles.badge, background: 'rgba(248,113,113,0.15)', color: '#f87171', border: '1px solid rgba(248,113,113,0.3)' }}>{value}</span>
    }
    if (['PENDING', 'IN_TRANSIT', 'IN_PROCESS', 'OPEN'].includes(value)) {
      return <span style={{ ...styles.badge, background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }}>{value}</span>
    }
  }
  return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, wordBreak: 'break-all' }}>{String(value)}</span>
}

function formatKey(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}

export default function NodeInspector({ node, onClose, onNeighborClick }) {
  const [detail, setDetail] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)

  useEffect(() => {
    if (!node) return
    setDetail(null)
    setLoadingDetail(true)

    fetch(`/api/graph/node/${encodeURIComponent(node.id)}`)
      .then(r => r.json())
      .then(data => setDetail(data))
      .catch(() => setDetail(null))
      .finally(() => setLoadingDetail(false))
  }, [node?.id])

  if (!node) return null

  const color = TYPE_COLOR[node.nodeType] || '#4f7df3'
  const typeLabel = TYPE_LABEL[node.nodeType] || node.nodeType

  const metaFields = Object.entries(node)
    .filter(([k]) => !HIDDEN_FIELDS.has(k))
    .filter(([, v]) => v !== null && v !== undefined && v !== '')

  const neighbors = detail?.neighbors || []
  const edges = detail?.edges || []

  return (
    <div style={styles.panel} className="fade-in">
      {/* Header */}
      <div style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
          <div style={{ ...styles.typeChip, background: `${color}22`, borderColor: `${color}44`, color }}>
            {typeLabel}
          </div>
        </div>
        <button onClick={onClose} style={styles.closeBtn}>
          <X size={14} />
        </button>
      </div>

      {/* Node ID */}
      <div style={styles.nodeId}>
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>ID</span>
        <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          {node.id}
        </span>
      </div>

      {/* Label */}
      <div style={styles.nodeLabel}>
        {node.label && node.label !== node.id ? node.label : ''}
      </div>

      {/* Metadata */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Properties</div>
        <div style={styles.fieldList}>
          {metaFields.map(([k, v]) => (
            <div key={k} style={styles.fieldRow}>
              <span style={styles.fieldKey}>{formatKey(k)}</span>
              <span style={styles.fieldVal}>{formatValue(k, v)}</span>
            </div>
          ))}
          <div style={styles.fieldRow}>
            <span style={styles.fieldKey}>Connections</span>
            <span style={{ ...styles.fieldVal, color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              {node.connections}
            </span>
          </div>
        </div>
      </div>

      {/* Edges */}
      {edges.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            <Link2 size={12} style={{ marginRight: 5 }} />
            Relationships ({edges.length})
          </div>
          <div style={styles.edgeList}>
            {edges.slice(0, 10).map(edge => {
              const isSource = edge.source === node.id || edge.source?.id === node.id
              return (
                <div key={edge.id} style={styles.edgeRow}>
                  <span style={{ color: isSource ? 'var(--accent)' : 'var(--text-muted)', fontSize: 10 }}>
                    {isSource ? '→' : '←'}
                  </span>
                  <span style={{ ...styles.edgeLabel, background: `${color}15`, color }}>{edge.label}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {isSource ? (edge.target?.id || edge.target) : (edge.source?.id || edge.source)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Neighbours */}
      {loadingDetail && (
        <div style={{ padding: '16px', textAlign: 'center' }}>
          <div className="spinner" style={{ margin: '0 auto' }} />
        </div>
      )}
      {!loadingDetail && neighbors.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Connected Nodes ({neighbors.length})</div>
          <div style={styles.neighborList}>
            {neighbors.slice(0, 12).map(nb => (
              <button
                key={nb.id}
                onClick={() => onNeighborClick?.(nb)}
                style={styles.neighborChip}
              >
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: TYPE_COLOR[nb.nodeType] || '#4f7df3', flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>
                  {nb.label || nb.id}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const styles = {
  panel: {
    width: '100%',
    height: '100%',
    background: 'var(--bg-panel)',
    borderLeft: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    padding: '14px 16px',
    borderBottom: '1px solid var(--border)',
    gap: 8,
    flexShrink: 0,
  },
  typeChip: {
    fontSize: 11,
    fontWeight: 500,
    padding: '3px 9px',
    borderRadius: 20,
    border: '1px solid',
  },
  closeBtn: {
    background: 'none',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: '4px 6px',
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  nodeId: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '12px 16px 0',
  },
  nodeLabel: {
    padding: '2px 16px 12px',
    fontSize: 15,
    fontWeight: 500,
    color: 'var(--text-primary)',
    borderBottom: '1px solid var(--border)',
  },
  section: {
    padding: '14px 16px',
    borderBottom: '1px solid var(--border)',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 10,
    display: 'flex',
    alignItems: 'center',
  },
  fieldList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  fieldRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
  },
  fieldKey: {
    color: 'var(--text-muted)',
    fontSize: 12,
    flexShrink: 0,
    paddingTop: 1,
  },
  fieldVal: {
    textAlign: 'right',
    color: 'var(--text-secondary)',
    fontSize: 12,
    maxWidth: '60%',
  },
  badge: {
    fontSize: 10,
    fontWeight: 500,
    padding: '2px 7px',
    borderRadius: 20,
  },
  edgeList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  edgeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  edgeLabel: {
    fontSize: 10,
    fontWeight: 500,
    padding: '2px 6px',
    borderRadius: 4,
    flexShrink: 0,
  },
  neighborList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  neighborChip: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '6px 10px',
    cursor: 'pointer',
    color: 'var(--text-secondary)',
    textAlign: 'left',
    width: '100%',
    transition: 'background 0.1s, border-color 0.1s',
    fontFamily: 'var(--font-sans)',
    fontSize: 12,
  },
}
