import { useState, useCallback } from 'react'
import GraphCanvas from './components/GraphCanvas'
import NodeInspector from './components/NodeInspector'
import ChatPanel from './components/ChatPanel'
import { useGraphData } from './hooks/useGraphData'
import { useChat } from './hooks/useChat'

export default function App() {
  const [selectedNode, setSelectedNode] = useState(null)

  const {
    graphData, meta, loading, error,
    highlightIds, highlightNodes, clearHighlight, refresh,
  } = useGraphData()

  const {
    messages, input, setInput, sendMessage, isLoading, clearChat,
  } = useChat({
    onHighlightNodes: highlightNodes,
    onClearHighlight: clearHighlight,
  })

  const handleNodeClick = useCallback((node) => {
    setSelectedNode(node)
  }, [])

  const handleNeighborClick = useCallback((node) => {
    setSelectedNode(node)
  }, [])

  return (
    <div style={styles.root}>
      {/* Left: Graph + optional inspector */}
      <div style={styles.graphSection}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <GraphCanvas
            graphData={graphData}
            meta={meta}
            loading={loading}
            error={error}
            highlightIds={highlightIds}
            onNodeClick={handleNodeClick}
            onRefresh={refresh}
          />
        </div>

        {/* Node inspector — slides in when node selected */}
        {selectedNode && (
          <div style={styles.inspectorPanel}>
            <NodeInspector
              node={selectedNode}
              onClose={() => setSelectedNode(null)}
              onNeighborClick={handleNeighborClick}
            />
          </div>
        )}
      </div>

      {/* Right: Chat */}
      <div style={styles.chatSection}>
        <ChatPanel
          messages={messages}
          input={input}
          setInput={setInput}
          onSend={sendMessage}
          isLoading={isLoading}
          onClear={clearChat}
        />
      </div>
    </div>
  )
}

const styles = {
  root: {
    display: 'flex',
    height: '100vh',
    width: '100vw',
    overflow: 'hidden',
    background: 'var(--bg-base)',
  },
  graphSection: {
    flex: 1,
    display: 'flex',
    minWidth: 0,
    overflow: 'hidden',
  },
  inspectorPanel: {
    width: 280,
    flexShrink: 0,
    height: '100%',
    overflowY: 'auto',
  },
  chatSection: {
    width: 380,
    flexShrink: 0,
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
}
