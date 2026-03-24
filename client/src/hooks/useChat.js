import { useState, useCallback, useRef } from 'react'

export function useChat({ onHighlightNodes, onClearHighlight }) {
  const [messages, setMessages]   = useState([
    {
      id: 'welcome',
      role: 'assistant',
      content: 'Hi! I can help you analyze the **Order to Cash** process. Ask me about orders, deliveries, billing documents, payments, customers, or products.',
      sql: null,
      results: null,
      blocked: false,
    }
  ])
  const [input, setInput]         = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const abortRef                  = useRef(null)

  const historyForAPI = useCallback(() => {
    return messages
      .filter(m => m.id !== 'welcome')
      .slice(-8)
      .map(m => ({ role: m.role, content: m.content }))
  }, [messages])

  const sendMessage = useCallback(async (text) => {
    const userText = (text || input).trim()
    if (!userText || isLoading) return

    setInput('')
    onClearHighlight?.()

    const userMsg = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: userText,
    }

    const assistantId = `assistant-${Date.now()}`
    const assistantMsg = {
      id: assistantId,
      role: 'assistant',
      content: '',
      sql: null,
      results: null,
      blocked: false,
      streaming: true,
      status: 'Thinking...',
    }

    setMessages(prev => [...prev, userMsg, assistantMsg])
    setIsLoading(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userText,
          history: historyForAPI(),
          stream: true,
        }),
      })

      if (!res.ok) throw new Error(`Server error: ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let answerText = ''
      let sqlText = null
      let resultsData = null
      let isBlocked = false

      const updateMsg = (patch) =>
        setMessages(prev =>
          prev.map(m => m.id === assistantId ? { ...m, ...patch } : m)
        )

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6))

            switch (event.type) {
              case 'status':
                updateMsg({ status: event.text })
                break
              case 'sql':
                sqlText = event.text
                updateMsg({ sql: event.text, status: 'Running query...' })
                break
              case 'results_meta':
                updateMsg({ status: `Found ${event.count} result(s). Writing answer...` })
                break
              case 'token':
                answerText += event.text
                updateMsg({ content: answerText, status: null })
                break
              case 'blocked':
                isBlocked = true
                answerText = event.text
                updateMsg({ content: event.text, blocked: true, streaming: false, status: null })
                break
              case 'done':
                resultsData = event.results
                // Extract node IDs from results for graph highlight
                if (resultsData?.length) {
                  const ids = extractNodeIds(resultsData)
                  if (ids.length) onHighlightNodes?.(ids)
                }
                break
              case 'error':
                answerText = `Sorry, something went wrong: ${event.text}`
                updateMsg({ content: answerText, streaming: false, status: null })
                break
            }
          } catch (_) {}
        }
      }

      updateMsg({
        content: answerText,
        sql: sqlText,
        results: resultsData,
        blocked: isBlocked,
        streaming: false,
        status: null,
      })
    } catch (err) {
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantId
            ? { ...m, content: `Error: ${err.message}`, streaming: false, status: null }
            : m
        )
      )
    } finally {
      setIsLoading(false)
    }
  }, [input, isLoading, historyForAPI, onHighlightNodes, onClearHighlight])

  const clearChat = useCallback(() => {
    setMessages([{
      id: 'welcome',
      role: 'assistant',
      content: 'Hi! I can help you analyze the **Order to Cash** process. Ask me about orders, deliveries, billing documents, payments, customers, or products.',
      sql: null, results: null, blocked: false,
    }])
    onClearHighlight?.()
  }, [onClearHighlight])

  return { messages, input, setInput, sendMessage, isLoading, clearChat }
}

// Extract known ID fields from SQL result rows for graph highlighting
function extractNodeIds(rows) {
  const ID_FIELDS = [
    'customer_id', 'order_id', 'delivery_id', 'billing_id',
    'material_id', 'plant_id', 'payment_id', 'journal_id',
    'item_id', 'address_id',
  ]
  const ids = new Set()
  for (const row of rows) {
    for (const field of ID_FIELDS) {
      if (row[field]) ids.add(String(row[field]))
    }
  }
  return Array.from(ids)
}
