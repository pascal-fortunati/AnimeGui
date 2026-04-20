import { useEffect, useRef, useState, type MouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { desktopDir, join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import {
  cancelJob,
  clearDone,
  getRuntimeCapabilities,
  listJobs,
  pauseJob,
  removeJob,
  resumeJob,
  retryJob,
  resolveVideoInputs,
  startJobOrBatch,
  updateJobSettings,
} from "./api";
import { QueuePanel } from "./components/Queue/QueuePanel";
import { SettingsPanel } from "./components/Settings/SettingsPanel";
import { MonitorPanel } from "./components/Monitor/MonitorPanel";
import { PreviewWindowPage } from "./components/Preview/PreviewWindowPage";
import { BootWindowPage } from "./components/Boot/BootWindowPage";
import { DvdSubtitleWindowPage } from "./components/DvdSubs/DvdSubtitleWindowPage";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import {
  sanitizeProcessingSettings,
  DEFAULT_SETTINGS,
  type PresetName,
  type ProcessingSettings,
  type QueueJob,
  type RuntimeCapabilities,
} from "./types";
import { t } from "./i18n";
import appLogo from "./assets/logo_up.png";

function settingsByPreset(
  preset: PresetName,
  base: ProcessingSettings,
): ProcessingSettings {
  if (preset === "Anime HD") {
    return sanitizeProcessingSettings({
      ...base,
      realcugan_model: "models-se",
      denoise_level: 2,
      upscale_factor: 2,
      video_codec: "h265",
      quality_mode: "crf",
      crf: 18,
      tta_mode: false,
    });
  }
  if (preset === "Old DVD") {
    return sanitizeProcessingSettings({
      ...base,
      realcugan_model: "models-se",
      denoise_level: 3,
      upscale_factor: 4,
      video_codec: "h265",
      quality_mode: "crf",
      crf: 20,
      tta_mode: false,
    });
  }
  if (preset === "High Quality") {
    return sanitizeProcessingSettings({
      ...base,
      realcugan_model: "models-se",
      denoise_level: 0,
      tta_mode: true,
      upscale_factor: 4,
      video_codec: "av1",
      quality_mode: "crf",
      crf: 16,
    });
  }
  return sanitizeProcessingSettings(base);
}

export function App() {
  const isPreviewWindow =
    new URLSearchParams(window.location.search).get("preview") === "1";
  const isBootWindow =
    new URLSearchParams(window.location.search).get("boot") === "1";
  const isDvdSubsWindow =
    new URLSearchParams(window.location.search).get("dvdsubs") === "1";

  if (isBootWindow) {
    return <BootWindowPage />;
  }

  if (isPreviewWindow) {
    return <PreviewWindowPage />;
  }

  if (isDvdSubsWindow) {
    return <DvdSubtitleWindowPage />;
  }

  const appWindow = getCurrentWindow();
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [inputPath, setInputPath] = useState("");
  const [inputTargets, setInputTargets] = useState<string[]>([]);
  const [preset, setPreset] = useState<PresetName>("Anime HD");
  const [runtimeCaps, setRuntimeCaps] = useState<RuntimeCapabilities | null>(
    null,
  );
  const autoOutputDirResolvedRef = useRef(false);
  const [settings, setSettings] = useState<ProcessingSettings>(
    settingsByPreset("Anime HD", DEFAULT_SETTINGS),
  );

  function withTimestamp(message: string) {
    const time = new Date().toLocaleTimeString("fr-FR", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return `[${time}] ${message}`;
  }

  function appendLocalLog(message: string) {
    setLogs((prev) => [...prev.slice(-250), withTimestamp(message)]);
  }

  useEffect(() => {
    void getRuntimeCapabilities()
      .then((caps) => {
        setRuntimeCaps(caps);
        setSettings((prev) =>
          sanitizeProcessingSettings({
            ...prev,
            hardware_accel: caps.hardware_accel_available,
          }),
        );
      })
      .catch((error) => {
        appendLocalLog(
          t("app.log.runtimeDetectError", { error: String(error) }),
        );
      });

    void refreshJobs().catch((error) => {
      appendLocalLog(t("app.log.refreshJobsError", { error: String(error) }));
    });

    const unlistenLogs = listen<string>("job-log", (event) => {
      setLogs((prev) => [...prev.slice(-250), withTimestamp(event.payload)]);
    });
    const unlistenStatus = listen<QueueJob>("job-status", (event) => {
      setJobs((prev) => {
        const index = prev.findIndex((job) => job.id === event.payload.id);
        if (index < 0) {
          return [...prev, event.payload];
        }
        const copy = [...prev];
        copy[index] = event.payload;
        return copy;
      });
    });
    return () => {
      void unlistenLogs.then((f) => f());
      void unlistenStatus.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (
      settings.output_dir.trim().length > 0 ||
      autoOutputDirResolvedRef.current
    ) {
      return;
    }
    autoOutputDirResolvedRef.current = true;
    void (async () => {
      try {
        const desktop = await desktopDir();
        const resolved = await join(desktop, "AnimeGui", "outputs");
        setSettings((prev) => {
          if (prev.output_dir.trim().length > 0) {
            return prev;
          }
          return {
            ...prev,
            output_dir: resolved,
          };
        });
        appendLocalLog(t("app.log.autoOutputDir", { path: resolved }));
      } catch (error) {
        autoOutputDirResolvedRef.current = false;
        appendLocalLog(
          t("app.log.autoOutputDirError", { error: String(error) }),
        );
      }
    })();
  }, [settings.output_dir]);

  async function refreshJobs() {
    setJobs(await listJobs());
  }

  async function pickInputFile() {
    try {
      const selected = await open({
        multiple: false,
        title: t("app.chooseSourceVideo"),
        filters: [
          {
            name: "Vidéos",
            extensions: ["mkv", "mp4", "avi", "mov", "webm", "m4v", "ts"],
          },
        ],
      });
      if (typeof selected === "string") {
        setInputPath(selected);
        setInputTargets([]);
        appendLocalLog(t("app.log.inputFileSelected", { path: selected }));
        await openPreviewFromPath(selected);
      }
    } catch (error) {
      appendLocalLog(t("app.log.inputFileError", { error: String(error) }));
    }
  }

  async function pickInputDirectory() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("app.chooseSourceDirectory"),
      });
      if (typeof selected === "string") {
        setInputPath(selected);
        setInputTargets([]);
        appendLocalLog(t("app.log.inputDirectorySelected", { path: selected }));
        await openPreviewFromPath(selected);
      }
    } catch (error) {
      appendLocalLog(
        t("app.log.inputDirectoryError", { error: String(error) }),
      );
    }
  }

  async function pickOutputDir() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("app.chooseOutputDirectory"),
      });
      if (typeof selected === "string") {
        setSettings((prev) => ({
          ...prev,
          output_dir: selected,
        }));
        appendLocalLog(
          t("app.log.outputDirectorySelected", { path: selected }),
        );
      }
    } catch (error) {
      appendLocalLog(
        t("app.log.outputDirectoryError", { error: String(error) }),
      );
    }
  }

  function onTitlebarPointerDown(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    void appWindow.startDragging();
  }

  function openPreviewWindowWithTargets(targets: string[]) {
    if (targets.length === 0) {
      appendLocalLog(t("app.log.selectVideoFirst"));
      return;
    }
    const primaryInput = targets[0];
    const previewId = settings.preview_session_id ?? `preview-${Date.now()}`;
    const previewSettings = sanitizeProcessingSettings({
      ...settings,
      preview_session_id: previewId,
    });
    setSettings(previewSettings);
    localStorage.setItem(
      "animegui-preview-context",
      JSON.stringify({
        inputPath: primaryInput,
        inputPaths: targets,
        settings: previewSettings,
        previewId,
      }),
    );
    const label = `preview-${Date.now()}`;
    new WebviewWindow(label, {
      title: t("app.previewWindowTitle"),
      url: "index.html?preview=1",
      width: 1280,
      height: 1000,
      center: true,
      resizable: true,
      decorations: false,
    });
  }

  async function openPreviewFromPath(targetPath: string) {
    if (!targetPath.trim()) {
      appendLocalLog(t("app.log.emptySourcePath"));
      return;
    }
    try {
      const resolved = await resolveVideoInputs(targetPath);
      setInputTargets(resolved);
      if (resolved.length > 1) {
        appendLocalLog(t("app.log.batchDetected", { count: resolved.length }));
      }
      openPreviewWindowWithTargets(resolved);
    } catch (error) {
      appendLocalLog(
        t("app.log.previewPrepareError", { error: String(error) }),
      );
    }
  }

  function openPreviewForJob(job: QueueJob) {
    const previewId = job.settings.preview_session_id ?? job.id;
    if (typeof job.settings.preview_last_frame_index === "number") {
      localStorage.setItem(
        `animegui-preview-state-${previewId}`,
        JSON.stringify({
          frameIndex: job.settings.preview_last_frame_index,
        }),
      );
    }
    localStorage.setItem(
      "animegui-preview-context",
      JSON.stringify({
        jobId: job.id,
        inputPath: job.input_path,
        inputPaths: [job.input_path],
        settings: sanitizeProcessingSettings({
          ...job.settings,
          preview_session_id: previewId,
        }),
        previewId,
      }),
    );
    const label = `preview-job-${job.id}-${Date.now()}`;
    new WebviewWindow(label, {
      title: t("app.previewWindowTitle"),
      url: "index.html?preview=1",
      width: 1400,
      height: 900,
      center: true,
      resizable: true,
      decorations: false,
    });
  }

  return (
    <main className="app">
      <header className="window-titlebar">
        <div
          className="window-drag-area"
          onMouseDown={onTitlebarPointerDown}
          onDoubleClick={() => void appWindow.toggleMaximize()}
        >
          <div className="titlebar-logo-wrap">
            <img className="titlebar-logo-img" src={appLogo} alt="AnimeGui" />
          </div>
        </div>
        <div
          className="window-controls"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            className="window-btn window-btn-min"
            type="button"
            aria-label="Minimize"
            onClick={() => void appWindow.minimize()}
          />
          <button
            className="window-btn window-btn-max"
            type="button"
            aria-label="Maximize"
            onClick={() => void appWindow.toggleMaximize()}
          />
          <button
            className="window-btn window-btn-close"
            type="button"
            aria-label="Close"
            onClick={() => void appWindow.close()}
          />
        </div>
      </header>
      <section className="app-content">
        <Card>
          <div className="input-row">
            <span className="material-symbols-rounded input-icon">movie</span>
            <input
              className="text-input"
              value={inputPath}
              onChange={(event) => {
                setInputPath(event.currentTarget.value);
                setInputTargets([]);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void openPreviewFromPath(inputPath);
                }
              }}
              placeholder={t("app.sourcePlaceholder")}
            />
            <Button variant="secondary" onClick={pickInputFile}>
              <span className="material-icons-round btn-icon">folder</span>
              {t("app.file")}
            </Button>
            <Button onClick={pickInputDirectory}>
              <span className="material-icons-round btn-icon">folder_open</span>
              {t("app.directory")}
            </Button>
          </div>
          {inputTargets.length > 1 ? (
            <div className="batch-hint">
              {t("app.batchDetected", { count: inputTargets.length })}
            </div>
          ) : null}
        </Card>
        <Card>
          <div className="input-row">
            <span className="material-symbols-rounded input-icon">
              folder_open
            </span>
            <input
              className="text-input"
              value={settings.output_dir}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  output_dir: event.currentTarget.value,
                }))
              }
              placeholder={t("app.outputPlaceholder")}
            />
            <Button variant="secondary" onClick={pickOutputDir}>
              <span className="material-icons-round btn-icon">folder</span>
              {t("app.browse")}
            </Button>
          </div>
        </Card>
        <SettingsPanel
          preset={preset}
          settings={settings}
          runtimeCaps={runtimeCaps}
          onPresetChange={(nextPreset) => {
            setPreset(nextPreset);
            setSettings(settingsByPreset(nextPreset, settings));
          }}
          onSettingsChange={(nextSettings) => {
            setPreset("Custom");
            setSettings(sanitizeProcessingSettings(nextSettings));
          }}
        />
        <QueuePanel
          jobs={jobs}
          onStartJob={async (jobId) => {
            try {
              appendLocalLog(t("app.log.startQueueRequested"));
              await startJobOrBatch(jobId);
              await refreshJobs();
            } catch (error) {
              appendLocalLog(
                t("app.log.startQueueError", { error: String(error) }),
              );
            }
          }}
          onApplyCurrentSettings={async (jobId) => {
            try {
              const targetJob = jobs.find((job) => job.id === jobId);
              const buildSafeSettingsForJob = (job: QueueJob | undefined) => {
                const isNonEmpty = (value: string | undefined): value is string =>
                  typeof value === "string" && value.trim().length > 0;

                const preservedManualCrop = isNonEmpty(job?.settings.manual_crop)
                  ? job?.settings.manual_crop
                  : undefined;
                const requestedManualCrop = isNonEmpty(settings.manual_crop)
                  ? settings.manual_crop
                  : undefined;
                const manualCropForJob = requestedManualCrop ?? preservedManualCrop;
                const preservedAudioSelection =
                  job?.settings.selected_audio_stream_index;
                const preservedSubtitleSelection =
                  job?.settings.selected_subtitle_stream_index;
                const preservedCopyAudio = job?.settings.copy_audio;
                const preservedCopySubs = job?.settings.copy_subs;
                const preservedSubtitleFormat =
                  job?.settings.subtitle_output_format;
                const preservedPreviewSessionId = isNonEmpty(
                  job?.settings.preview_session_id,
                )
                  ? job?.settings.preview_session_id
                  : undefined;
                const preservedExternalSrtPath = isNonEmpty(
                  job?.settings.external_srt_path,
                )
                  ? job?.settings.external_srt_path
                  : undefined;
                const requestedExternalSrtPath = isNonEmpty(
                  settings.external_srt_path,
                )
                  ? settings.external_srt_path
                  : undefined;
                const externalSrtForJob =
                  preservedExternalSrtPath ?? requestedExternalSrtPath;
                const hasExternalSrt = Boolean(externalSrtForJob);

                return sanitizeProcessingSettings({
                  ...settings,
                  manual_crop: manualCropForJob,
                  auto_crop: manualCropForJob ? false : settings.auto_crop,
                  selected_audio_stream_index: preservedAudioSelection,
                  selected_subtitle_stream_index: hasExternalSrt
                    ? undefined
                    : preservedSubtitleSelection,
                  copy_audio: preservedCopyAudio ?? settings.copy_audio,
                  copy_subs: hasExternalSrt
                    ? false
                    : (preservedCopySubs ?? settings.copy_subs),
                  subtitle_output_format:
                    hasExternalSrt
                      ? "copy"
                      : (preservedSubtitleFormat ?? settings.subtitle_output_format),
                  preview_session_id:
                    preservedPreviewSessionId ??
                    settings.preview_session_id ??
                    `job-preview-${jobId}`,
                  preview_last_frame_index:
                    job?.settings.preview_last_frame_index ??
                    settings.preview_last_frame_index,
                  external_srt_path: externalSrtForJob,
                });
              };

              const safeSettings = buildSafeSettingsForJob(targetJob);
              setSettings(safeSettings);
              const batchSessionId = targetJob?.settings.preview_session_id;
              const batchJobs = batchSessionId
                ? jobs.filter(
                  (job) =>
                    job.settings.preview_session_id === batchSessionId &&
                    (job.status === "waiting" ||
                      job.status === "paused" ||
                      job.status === "error" ||
                      job.status === "canceled"),
                )
                : [];
              if (batchJobs.length > 1) {
                await Promise.all(
                  batchJobs.map((job) =>
                    updateJobSettings(job.id, buildSafeSettingsForJob(job)),
                  ),
                );
                appendLocalLog(
                  t("app.log.batchSettingsApplied", {
                    id: batchSessionId ?? "-",
                    count: batchJobs.length,
                  }),
                );
              } else {
                const updated = await updateJobSettings(jobId, safeSettings);
                appendLocalLog(
                  t("app.log.jobSettingsUpdated", { id: updated.id }),
                );
              }
              await refreshJobs();
            } catch (error) {
              appendLocalLog(
                t("app.log.updateSettingsError", {
                  id: jobId,
                  error: String(error),
                }),
              );
            }
          }}
          onPause={async (jobId) => {
            try {
              await pauseJob(jobId);
              await refreshJobs();
            } catch (error) {
              appendLocalLog(
                t("app.log.pauseError", { id: jobId, error: String(error) }),
              );
            }
          }}
          onResume={async (jobId) => {
            try {
              await resumeJob(jobId);
              await refreshJobs();
            } catch (error) {
              appendLocalLog(
                t("app.log.resumeError", { id: jobId, error: String(error) }),
              );
            }
          }}
          onCancel={async (jobId) => {
            try {
              await cancelJob(jobId);
              await refreshJobs();
            } catch (error) {
              appendLocalLog(
                t("app.log.cancelError", { id: jobId, error: String(error) }),
              );
            }
          }}
          onRetry={async (jobId) => {
            try {
              await retryJob(jobId);
              await startJobOrBatch(jobId);
              await refreshJobs();
            } catch (error) {
              appendLocalLog(
                t("app.log.retryError", { id: jobId, error: String(error) }),
              );
            }
          }}
          onDelete={async (jobId) => {
            try {
              await removeJob(jobId);
              await refreshJobs();
            } catch (error) {
              appendLocalLog(
                t("app.log.deleteError", { id: jobId, error: String(error) }),
              );
            }
          }}
          onClearDone={async () => {
            try {
              await clearDone();
              await refreshJobs();
            } catch (error) {
              appendLocalLog(
                t("app.log.clearDoneError", { error: String(error) }),
              );
            }
          }}
          onOpenPreview={openPreviewForJob}
        />
        <MonitorPanel logs={logs} />
      </section>
    </main>
  );
}
