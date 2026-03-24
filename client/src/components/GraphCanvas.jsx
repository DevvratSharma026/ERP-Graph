import { useRef, useCallback, useEffect, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { RefreshCw, Maximize2, Minimize2, Info } from 'lucide-react'

const NODE_TYPE_LABELS = {
  customers:         'Customer',
  sales_orders:      'Sales Order',
  sales_order_items: 'SO Item',
  products:          'Product',
  plants:            'Plant',
  addresses:         'Address',
  deliveries:        'Delivery',
  billing_docs:      'Billing Doc',
  journal_entries:   'Journal Entry',
  payments:          'Payment',
}

const LEGEND = [
  { type: 'customers',         color: '#7c6af7', label: 'Customer' },
  { type: 'sales_orders',      color: '#4f7df3', label: 'Sales Order' },
  { type: 'deliveries',        color: '#2dd4bf', label: 'Delivery' },
  { type: 'billing_docs',      color: '#f59e0b', label: 'Billing Doc' },
  { type: 'journal_entries',   color: '#f97316', label: 'Journal Entry' },
  { type: 'payments',          color: '#34d399', label: 'Payment' },
  { type: 'products',          color: '#a3e635', label: 'Product' },
  { type: 'plants',            color: '#94a3b8', label: 'Plant' },
]

export default function GraphCanvas({
  graphData,
  meta,
  loading,
  error,
  highlightIds,
  onNodeClick,
  onRefresh,
}) {
  const fgRef       = useRef(null)
  const containerRef = useRef(null)
  const [dims, setDims]         = useState({ w: 800, h: 600 })
  const [minimized, setMinimized] = useState(false)
  const [showLegend, setShowLegend] = useState(true)
  const [hoveredNode, setHoveredNode] = useState(null)

  // Responsive sizing
  useEffect(() => {
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      setDims({ w: width, h: height })
    })
    if (containerRef.current) obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [])

  // Auto-zoom to fit on first load
  useEffect(() => {
    if (!loading && graphData.nodes.length && fgRef.current) {
      setTimeout(() => fgRef.current?.zoomToFit(400, 60), 500)
    }
  }, [loading, graphData.nodes.length])

  const getNodeColor = useCallback((node) => {
    if (highlightIds.size > 0) {
      if (highlightIds.has(node.id)) return node.color || '#4f7df3'
      return '#1e2230'
    }
    return node.color || '#4f7df3'
  }, [highlightIds])

  const getNodeSize = useCallback((node) => {
    const base = 4
    const connBonus = Math.min(node.connections || 0, 20) * 0.4
    const highlighted = highlightIds.size > 0 && highlightIds.has(node.id)
    return (base + connBonus) * (highlighted ? 1.6 : 1)
  }, [highlightIds])

  const getLinkColor = useCallback((link) => {
    const srcId = typeof link.source === 'object' ? link.source.id : link.source
    const tgtId = typeof link.target === 'object' ? link.target.id : link.target
    if (highlightIds.size > 0) {
      if (highlightIds.has(srcId) || highlightIds.has(tgtId)) {
        return 'rgba(79,125,243,0.7)'
      }
      return 'rgba(255,255,255,0.03)'
    }
    return 'rgba(255,255,255,0.08)'
  }, [highlightIds])

  const paintNode = useCallback((node, ctx, globalScale) => {
    const r = getNodeSize(node)
    const isHighlighted = highlightIds.size > 0 && highlightIds.has(node.id)
    const isHovered = hoveredNode?.id === node.id

    // Glow for highlighted/hovered
    if (isHighlighted || isHovered) {
      ctx.beginPath()
      ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI)
      const grad = ctx.createRadialGradient(node.x, node.y, r, node.x, node.y, r + 8)
      grad.addColorStop(0, `${node.color}55`)
      grad.addColorStop(1, 'transparent')
      ctx.fillStyle = grad
      ctx.fill()
    }

    // Node circle
    ctx.beginPath()
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
    ctx.fillStyle = getNodeColor(node)
    ctx.fill()

    // Border
    ctx.strokeStyle = isHighlighted ? '#fff' : 'rgba(255,255,255,0.15)'
    ctx.lineWidth = isHighlighted ? 1.5 : 0.5
    ctx.stroke()

    // Label at mid-zoom+
    if (isHighlighted || isHovered) {
      const label = (node.label || node.id).slice(0, 18)
      const fontSize = Math.max(8, 10 / globalScale)
      ctx.font = `${fontSize}px Inter, sans-serif`
      ctx.fillStyle = isHighlighted ? '#fff' : 'rgba(220,225,240,0.8)'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(label, node.x, node.y + r + 2)
    }
  }, [getNodeColor, getNodeSize, highlightIds, hoveredNode])

  const handleNodeClick = useCallback((node) => {
    onNodeClick?.(node)
    // Zoom into clicked node
    fgRef.current?.centerAt(node.x, node.y, 600)
    fgRef.current?.zoom(4, 600)
  }, [onNodeClick])

  const handleZoomToFit = () => fgRef.current?.zoomToFit(400, 60)

  if (error) {
    return (
      <div style={styles.errorState}>
        <p style={{ color: 'var(--red)', marginBottom: 12 }}>⚠ Could not load graph</p>
        <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 16 }}>{error}</p>
        <button onClick={onRefresh} style={styles.btn}>Retry</button>
      </div>
    )
  }

  return (
    <div ref={containerRef} style={styles.container}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.breadcrumb}>
          <span style={{ color: 'var(--text-muted)' }}>Mapping</span>
          <span style={{ color: 'var(--text-muted)', margin: '0 6px' }}>/</span>
          <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>Order to Cash</span>
        </div>
        <div style={styles.toolbarActions}>
          {meta && (
            <span style={styles.metaTag}>
              {meta.nodeCount.toLocaleString()} nodes · {meta.edgeCount.toLocaleString()} edges
            </span>
          )}
          <button
            onClick={() => setShowLegend(v => !v)}
            style={styles.iconBtn}
            title="Toggle legend"
          >
            <Info size={14} />
          </button>
          <button onClick={handleZoomToFit} style={styles.iconBtn} title="Fit to screen">
            <Maximize2 size={14} />
          </button>
          <button onClick={onRefresh} style={styles.iconBtn} title="Refresh graph">
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {/* Legend overlay */}
      {showLegend && (
        <div style={styles.legend}>
          {LEGEND.map(item => (
            <div key={item.type} style={styles.legendItem}>
              <div style={{ ...styles.legendDot, background: item.color }} />
              <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{item.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Loading overlay */}
      {loading && (
        <div style={styles.loadingOverlay}>
          <div className="spinner" style={{ width: 28, height: 28, marginBottom: 12 }} />
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Building graph...</p>
        </div>
      )}

      {/* Hovered node tooltip */}
      {hoveredNode && !loading && (
        <div style={styles.tooltip}>
          <div style={{ color: 'var(--text-primary)', fontWeight: 500, marginBottom: 4 }}>
            {hoveredNode.label || hoveredNode.id}
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
            {NODE_TYPE_LABELS[hoveredNode.nodeType] || hoveredNode.nodeType}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>
            {hoveredNode.connections} connection{hoveredNode.connections !== 1 ? 's' : ''}
          </div>
        </div>
      )}

      {/* Force graph */}
      {!loading && (
        <ForceGraph2D
          ref={fgRef}
          graphData={graphData}
          width={dims.w}
          height={dims.h}
          backgroundColor="#0e0f11"
          nodeCanvasObject={paintNode}
          nodeCanvasObjectMode={() => 'replace'}
          linkColor={getLinkColor}
          linkWidth={link => {
            const srcId = typeof link.source === 'object' ? link.source.id : link.source
            const tgtId = typeof link.target === 'object' ? link.target.id : link.target
            if (highlightIds.size > 0 && (highlightIds.has(srcId) || highlightIds.has(tgtId))) return 1.5
            return 0.5
          }}
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={1}
          linkDirectionalParticles={link => {
            const srcId = typeof link.source === 'object' ? link.source.id : link.source
            if (highlightIds.size > 0 && highlightIds.has(srcId)) return 2
            return 0
          }}
          linkDirectionalParticleSpeed={0.005}
          linkDirectionalParticleColor={() => 'rgba(79,125,243,0.8)'}
          onNodeClick={handleNodeClick}
          onNodeHover={node => setHoveredNode(node || null)}
          cooldownTicks={120}
          d3AlphaDecay={0.02}
          d3VelocityDecay={0.3}
          nodePointerAreaPaint={(node, color, ctx) => {
            const r = getNodeSize(node) + 4
            ctx.beginPath()
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
            ctx.fillStyle = color
            ctx.fill()
          }}
        />
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
      `}</style>
    </div>
  )
}

const styles = {
  container: {
    position: 'relative',
    width: '100%',
    height: '100%',
    background: '#0e0f11',
    overflow: 'hidden',
  },
  toolbar: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 16px',
    background: 'linear-gradient(to bottom, rgba(14,15,17,0.95), transparent)',
  },
  breadcrumb: {
    display: 'flex',
    alignItems: 'center',
    fontSize: 13,
  },
  toolbarActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  metaTag: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid var(--border)',
    borderRadius: 20,
    padding: '3px 10px',
    fontSize: 11,
    color: 'var(--text-secondary)',
  },
  iconBtn: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: '5px 7px',
    display: 'flex',
    alignItems: 'center',
    transition: 'background 0.15s',
  },
  legend: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    zIndex: 10,
    background: 'rgba(20,22,26,0.92)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '10px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    backdropFilter: 'blur(8px)',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  legendDot: {
    width: 8, height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  tooltip: {
    position: 'absolute',
    bottom: 16,
    right: 16,
    zIndex: 20,
    background: 'rgba(20,22,26,0.95)',
    border: '1px solid var(--border-light)',
    borderRadius: 10,
    padding: '10px 14px',
    minWidth: 160,
    backdropFilter: 'blur(8px)',
    pointerEvents: 'none',
  },
  loadingOverlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
    background: '#0e0f11',
  },
  errorState: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    textAlign: 'center',
  },
  btn: {
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '8px 20px',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
  },
}
