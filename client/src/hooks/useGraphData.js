import { useState, useEffect, useCallback, useRef } from 'react'

export function useGraphData() {
  const [graphData, setGraphData]   = useState({ nodes: [], links: [] })
  const [meta, setMeta]             = useState(null)
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState(null)
  const [highlightIds, setHighlightIds] = useState(new Set())
  const rawEdgesRef = useRef([])

  const fetchGraph = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/graph')
      if (!res.ok) throw new Error(`Graph fetch failed: ${res.status}`)
      const data = await res.json()

      // react-force-graph-2d expects { nodes, links } — edges → links
      rawEdgesRef.current = data.edges || []
      setGraphData({
        nodes: data.nodes || [],
        links: (data.edges || []).map(e => ({
          ...e,
          source: e.source,
          target: e.target,
        })),
      })

      const metaRes = await fetch('/api/graph/meta')
      if (metaRes.ok) setMeta(await metaRes.json())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchGraph() }, [fetchGraph])

  const highlightNodes = useCallback((ids) => {
    setHighlightIds(new Set(ids))
  }, [])

  const clearHighlight = useCallback(() => {
    setHighlightIds(new Set())
  }, [])

  return {
    graphData,
    meta,
    loading,
    error,
    highlightIds,
    highlightNodes,
    clearHighlight,
    refresh: fetchGraph,
  }
}
