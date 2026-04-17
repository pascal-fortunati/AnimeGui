import { useEffect, useMemo, useRef, useState } from "react"
import { Card } from "../ui/card"
import { ScrollArea } from "../ui/scroll-area"
import { Switch } from "../ui/switch"
import { t } from "../../i18n"

interface MonitorPanelProps {
  logs: string[]
}

function parseLogLine(rawLine: string) {
  const match = rawLine.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/)
  const timestamp = match?.[1] ?? null
  const message = (match?.[2] ?? rawLine).trim()
  const lowerMessage = message.toLowerCase()

  let levelClass = "log-default"
  if (/erreur|error|failed|échec|fatal|panic/.test(lowerMessage)) {
    levelClass = "log-err"
  } else if (/warn|warning|spike|attention|pause|annul/.test(lowerMessage)) {
    levelClass = "log-warn"
  } else if (/terminé|done|ok|success|complete|ajouté|repris|reprise/.test(lowerMessage)) {
    levelClass = "log-ok"
  } else if (/info|analyse|chunk|frame|fps|extract|upscale|encod|remux|queue/.test(lowerMessage)) {
    levelClass = "log-info"
  }

  return { timestamp, message, levelClass }
}

export function MonitorPanel({ logs }: MonitorPanelProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const reversedLogs = useMemo(() => [...logs].reverse(), [logs])

  useEffect(() => {
    const root = scrollContainerRef.current
    if (!root) {
      return
    }
    const viewport = root.querySelector<HTMLElement>(".scroll-area-viewport")
    if (!viewport) {
      return
    }
    if (autoScroll) {
      viewport.scrollTop = 0
    }
  }, [reversedLogs, autoScroll])

  return (
    <Card className="monitor-card">
      <div className="panel-header">
        <h2>
          <span className="dot" />
          {t("monitor.title")}
        </h2>
        <div className="monitor-live">
          <label className="field-inline monitor-autoscroll-toggle">
            <span>{t("monitor.autoscroll")}</span>
            <Switch
              checked={autoScroll}
              onCheckedChange={(value) => {
                setAutoScroll(value)
                if (value) {
                  const root = scrollContainerRef.current
                  const viewport = root?.querySelector<HTMLElement>(".scroll-area-viewport")
                  if (viewport) {
                    viewport.scrollTop = 0
                  }
                }
              }}
            />
          </label>
          {t("monitor.live")}
          <span className="material-icons-round live-dot">circle</span>
        </div>
      </div>
      <ScrollArea className="logs-area" ref={scrollContainerRef}>
        <div className="logs-content">
          {reversedLogs.map((rawLog, index) => {
            const parsed = parseLogLine(rawLog)
            return (
              <div key={`${rawLog}-${index}`} className="log-line">
                {parsed.timestamp ? <span className="log-ts">{parsed.timestamp}</span> : null}
                <span className={parsed.levelClass}>{parsed.message}</span>
              </div>
            )
          })}
          {logs.length === 0 ? (
            <div className="log-line">
              <span className="log-default">{t("monitor.empty")}</span>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </Card>
  )
}