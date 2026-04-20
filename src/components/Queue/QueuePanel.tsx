import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Progress } from "../ui/progress";
import type { QueueJob } from "../../types";
import { t } from "../../i18n";

interface QueuePanelProps {
  jobs: QueueJob[];
  onStartJob: (jobId: string) => Promise<void>;
  onApplyCurrentSettings: (jobId: string) => Promise<void>;
  onPause: (jobId: string) => Promise<void>;
  onResume: (jobId: string) => Promise<void>;
  onCancel: (jobId: string) => Promise<void>;
  onRetry: (jobId: string) => Promise<void>;
  onDelete: (jobId: string) => Promise<void>;
  onClearDone: () => Promise<void>;
  onOpenPreview: (job: QueueJob) => void;
}

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

function ratio(current: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, (current / total) * 100);
}

function statusIcon(status: QueueJob["status"]): string {
  switch (status) {
    case "done": return "check_circle";
    case "processing": return "sync";
    case "paused": return "pause_circle";
    case "error": return "error";
    case "canceled": return "cancel";
    default: return "radio_button_unchecked";
  }
}

function statusLabel(status: QueueJob["status"]): string {
  switch (status) {
    case "processing":
      return t("queue.active");
    case "waiting":
      return t("queue.waiting");
    case "done":
      return t("queue.done");
    case "canceled":
      return t("queue.canceled");
    case "paused":
      return t("queue.paused");
    case "error":
      return t("queue.error");
    default:
      return status;
  }
}

function etaLabel(seconds: number | null | undefined): string {
  if (seconds === undefined || seconds === null || seconds <= 0) return "";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

export function QueuePanel({
  jobs,
  onStartJob,
  onApplyCurrentSettings,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onDelete,
  onClearDone,
  onOpenPreview,
}: QueuePanelProps) {
  // Batch grouping by preview_session_id
  const batchOwner = new Map<string, string>();
  const batchCount = new Map<string, number>();
  for (const job of jobs) {
    const sid = job.settings.preview_session_id;
    if (!sid) continue;
    if (!batchOwner.has(sid)) batchOwner.set(sid, job.id);
    batchCount.set(sid, (batchCount.get(sid) ?? 0) + 1);
  }

  const isEditable = (status: QueueJob["status"]) =>
    status === "waiting" || status === "paused" || status === "error" || status === "canceled";

  const canCancel = (status: QueueJob["status"]) =>
    status === "waiting" || status === "processing" || status === "paused";

  const activeCount = jobs.filter(j => j.status === "processing" || j.status === "paused").length;
  const waitingCount = jobs.filter(j => j.status === "waiting").length;
  const doneCount = jobs.filter(j => j.status === "done").length;
  const canceledCount = jobs.filter(j => j.status === "canceled").length;
  const [queueTab, setQueueTab] = useState<"active" | "waiting" | "done" | "canceled">("waiting");

  useEffect(() => {
    if (activeCount > 0 && queueTab === "waiting") {
      setQueueTab("active");
    }
  }, [activeCount, queueTab]);

  const visibleJobs = jobs.filter((job) =>
    queueTab === "active"
      ? job.status === "processing" || job.status === "paused"
      : queueTab === "waiting"
        ? job.status === "waiting"
        : queueTab === "canceled"
          ? job.status === "canceled"
          : job.status === "done" || job.status === "error",
  );

  return (
    <Card className={`queue-card queue-card--${queueTab}`}>
      <div className="panel-header">
        <h2>
          <span className="dot" />
          {t("queue.title")}
          <span className="h2-sub">{t("queue.jobs", { count: jobs.length })}</span>
          {activeCount > 0 && <span className="queue-badge queue-badge-active">{activeCount} {t("queue.active").toLowerCase()}</span>}
          {waitingCount > 0 && <span className="queue-badge queue-badge-wait">{waitingCount} {t("queue.waiting").toLowerCase()}</span>}
        </h2>
        <div className="row">
          <div className="queue-tabs">
            <button
              type="button"
              className={`queue-tab ${queueTab === "active" ? "is-active" : ""}`}
              onClick={() => setQueueTab("active")}
            >
              {t("queue.active")} ({activeCount})
            </button>
            <button
              type="button"
              className={`queue-tab ${queueTab === "waiting" ? "is-active" : ""}`}
              onClick={() => setQueueTab("waiting")}
            >
              {t("queue.waiting")} ({waitingCount})
            </button>
            <button
              type="button"
              className={`queue-tab ${queueTab === "done" ? "is-active" : ""}`}
              onClick={() => setQueueTab("done")}
            >
              {t("queue.done")} ({doneCount})
            </button>
            <button
              type="button"
              className={`queue-tab ${queueTab === "canceled" ? "is-active" : ""}`}
              onClick={() => setQueueTab("canceled")}
            >
              {t("queue.canceled")} ({canceledCount})
            </button>
          </div>
          {doneCount > 0 && (
            <Button variant="secondary" className="btn-sm" onClick={onClearDone}>
              <span className="material-icons-round btn-icon">clear_all</span>
              {t("queue.clearDone", { count: doneCount })}
            </Button>
          )}
        </div>
      </div>

      <div className="job-list">
        {visibleJobs.length === 0 && (
          <div className="job-empty">
            <span className="material-icons-round">inbox</span>
            <span>
              {queueTab === "waiting"
                ? t("queue.noWaiting")
                : queueTab === "active"
                  ? t("queue.noActive")
                  : queueTab === "canceled"
                    ? t("queue.noCanceled")
                    : t("queue.noDone")}
            </span>
          </div>
        )}

        {visibleJobs.map((job) => {
          const sid = job.settings.preview_session_id;
          const batchSize = sid ? (batchCount.get(sid) ?? 0) : 0;
          const isBatchOwn = sid ? batchOwner.get(sid) === job.id : false;
          const showApply = !sid || batchSize <= 1 || isBatchOwn;
          const hasExtract = job.extract_total > 0;
          const hasUpscale = job.upscale_total > 0;
          const isActive = job.status === "processing";
          const isCompact = queueTab === "waiting" || job.status === "waiting";
          const showStages = queueTab === "active" ? true : (hasExtract || hasUpscale || isActive);
          const fpsLabel = job.fps > 0 ? `${job.fps.toFixed(2)} fps IA` : "-- fps IA";
          const etaRaw = etaLabel(job.eta_seconds);
          const etaDisplay = etaRaw.length > 0 ? `ETA ${etaRaw}` : "ETA --";
          const hasExternalSrt =
            typeof job.settings.external_srt_path === "string"
            && job.settings.external_srt_path.trim().length > 0;
          const subtitleBadgeClass = hasExternalSrt
            ? "job-subs-badge job-subs-badge--external"
            : job.settings.copy_subs
              ? "job-subs-badge job-subs-badge--source"
              : "job-subs-badge job-subs-badge--none";
          const subtitleBadgeLabel = hasExternalSrt
            ? t("queue.subsExternal", {
              file: basename(job.settings.external_srt_path as string),
            })
            : job.settings.copy_subs
              ? t("queue.subsSource")
              : t("queue.subsNone");

          return (
            <div
              key={job.id}
              className={`job-item job-item--${job.status} ${isCompact ? "job-item--compact" : ""}`}
              onDoubleClick={() => onOpenPreview(job)}
            >
              {/* Left accent bar via CSS */}

              {/* Icon */}
              <div className="job-icon">
                <span className={`material-icons-round job-status-icon job-status-icon--${job.status}`}>
                  {statusIcon(job.status)}
                </span>
              </div>

              {/* Main content column */}
              <div className="job-body">

                {/* Row 1 — filename + badges */}
                <div className="job-header-row">
                  <span className="job-title" title={job.input_path}>
                    {basename(job.input_path)}
                  </span>
                  <div className="job-badges">
                    <span className={`status-badge status-${job.status}`}>
                      {statusLabel(job.status)}
                    </span>
                    {batchSize > 1 && (
                      <span className="status-badge job-batch-badge">
                        <span className="material-icons-round status-icon">layers</span>
                        {t("queue.batch", { count: batchSize })}
                      </span>
                    )}
                    <span
                      className={`status-badge ${subtitleBadgeClass}`}
                      title={hasExternalSrt ? (job.settings.external_srt_path as string) : subtitleBadgeLabel}
                    >
                      <span className="material-icons-round status-icon">subtitles</span>
                      {subtitleBadgeLabel}
                    </span>
                  </div>
                </div>

                {/* Row 2 — stats */}
                {!isCompact ? (
                  <div className="job-stats">
                    <span className="job-stat">
                      <span className="material-icons-round job-stat-icon">percent</span>
                      {job.progress.toFixed(1)}%
                    </span>
                    <span className="job-stat">
                      <span className="material-icons-round job-stat-icon">speed</span>
                      {fpsLabel}
                    </span>
                    <span className="job-stat">
                      <span className="material-icons-round job-stat-icon">schedule</span>
                      {etaDisplay}
                    </span>
                  </div>
                ) : null}

                <div className="job-main-row">
                  {!isCompact ? (
                    <div className="job-prog-wrap">
                      <div
                        className={`job-prog ${job.status === "done" ? "prog-done" : isActive ? "prog-processing" : "prog-idle"}`}
                        style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }}
                      />
                    </div>
                  ) : (
                    <div className="job-prog-spacer" />
                  )}

                  <div className="job-actions">
                    {isEditable(job.status) && (
                      <Button className="btn-sm" onClick={() => { setQueueTab("active"); void onStartJob(job.id); }}>
                        <span className="material-icons-round btn-icon">play_arrow</span>
                        {t("queue.start")}
                      </Button>
                    )}

                    {isEditable(job.status) && (
                      showApply ? (
                        <Button variant="secondary" className="btn-sm" onClick={() => onApplyCurrentSettings(job.id)}>
                          <span className="material-icons-round btn-icon">tune</span>
                          {batchSize > 1 ? t("queue.applyBatch", { count: batchSize }) : t("queue.applySettings")}
                        </Button>
                      ) : (
                        <span className="job-batch-note">{t("queue.batchShared")}</span>
                      )
                    )}

                    {job.status === "processing" && (
                      <Button variant="secondary" className="btn-sm" onClick={() => onPause(job.id)}>
                        <span className="material-icons-round btn-icon">pause</span>
                        {t("queue.pause")}
                      </Button>
                    )}

                    {job.status === "paused" && (
                      <Button variant="secondary" className="btn-sm" onClick={() => onResume(job.id)}>
                        <span className="material-icons-round btn-icon">play_arrow</span>
                        {t("queue.resume")}
                      </Button>
                    )}

                    {canCancel(job.status) && (
                      <Button variant="danger" className="btn-sm" onClick={() => onCancel(job.id)}>
                        <span className="material-icons-round btn-icon">close</span>
                        {t("queue.cancel")}
                      </Button>
                    )}

                    {(job.status === "error" || job.status === "canceled") && (
                      <Button variant="secondary" className="btn-sm" onClick={() => onRetry(job.id)}>
                        <span className="material-icons-round btn-icon">refresh</span>
                        {t("queue.retry")}
                      </Button>
                    )}

                    {queueTab === "canceled" && job.status === "canceled" && (
                      <Button variant="danger" className="btn-sm" onClick={() => onDelete(job.id)}>
                        <span className="material-icons-round btn-icon">delete</span>
                        {t("queue.delete")}
                      </Button>
                    )}
                  </div>
                </div>

                {/* Row 4 — stage bars (always rendered when data present) */}
                {!isCompact && showStages && (
                  <div className="job-stages">
                    <div className={`job-stage ${hasExtract ? "" : "job-stage--pending"}`}>
                      <div className="job-stage-head">
                        <span className="material-icons-round job-stage-icon">movie_filter</span>
                        <span className="job-stage-label">{t("queue.extract")}</span>
                        <span className="job-stage-count">
                          {hasExtract
                            ? `${job.extract_current.toLocaleString()} / ${job.extract_total.toLocaleString()} ${t("queue.frames")}`
                            : t("queue.preparing")}
                        </span>
                      </div>
                      <Progress
                        value={hasExtract ? ratio(job.extract_current, job.extract_total) : 0}
                        className="job-stage-progress"
                        indicatorClassName="job-stage-progress-indicator"
                      />
                    </div>
                    <div className={`job-stage ${hasUpscale ? "" : "job-stage--pending"}`}>
                      <div className="job-stage-head">
                        <span className="material-icons-round job-stage-icon">auto_fix_high</span>
                        <span className="job-stage-label">{t("queue.upscale")}</span>
                        <span className="job-stage-count">
                          {hasUpscale
                            ? `${job.upscale_current.toLocaleString()} / ${job.upscale_total.toLocaleString()} ${t("queue.frames")}`
                            : t("queue.pending")}
                        </span>
                      </div>
                      <Progress
                        value={hasUpscale ? ratio(job.upscale_current, job.upscale_total) : 0}
                        className="job-stage-progress"
                        indicatorClassName="job-stage-progress-indicator upscaler"
                      />
                    </div>
                  </div>
                )}

                {/* Row 5 — error */}
                {job.error && (
                  <div className="job-error">
                    <span className="material-icons-round" style={{ fontSize: 12 }}>error_outline</span>
                    {job.error}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
