import { invoke } from "@tauri-apps/api/core";
import type {
  OcrUserReplacement,
  DvdOcrExportRequest,
  DvdOcrLine,
  DvdOcrLineRequest,
  DvdOcrStartRequest,
  DvdOcrStartResult,
  DvdSubtitleExtractRequest,
  DvdSubtitleExtractResult,
  DvdSubtitleTrackCandidate,
  PreviewFrameResult,
  ProcessingSettings,
  QueueJob,
  RuntimeCapabilities,
  VideoAnalysis,
} from "./types";

export async function addJob(
  inputPath: string,
  settings: ProcessingSettings,
): Promise<QueueJob> {
  return invoke<QueueJob>("add_job", { inputPath, settings });
}

export async function listJobs(): Promise<QueueJob[]> {
  return invoke<QueueJob[]>("list_jobs");
}

export async function startJobOrBatch(jobId: string): Promise<void> {
  await invoke("start_job_or_batch", { jobId });
}

export async function pauseJob(jobId: string): Promise<void> {
  await invoke("pause_job", { jobId });
}

export async function resumeJob(jobId: string): Promise<void> {
  await invoke("resume_job", { jobId });
}

export async function cancelJob(jobId: string): Promise<void> {
  await invoke("cancel_job", { jobId });
}

export async function retryJob(jobId: string): Promise<void> {
  await invoke("retry_job", { jobId });
}

export async function clearDone(): Promise<void> {
  await invoke("clear_done_jobs");
}

export async function removeJob(jobId: string): Promise<void> {
  await invoke("remove_job", { jobId });
}

export async function updateJobSettings(
  jobId: string,
  settings: ProcessingSettings,
): Promise<QueueJob> {
  return invoke<QueueJob>("update_job_settings", { jobId, settings });
}

export async function analyzeFile(inputPath: string): Promise<VideoAnalysis> {
  return invoke<VideoAnalysis>("analyze_file", { inputPath });
}

export async function resolveVideoInputs(inputPath: string): Promise<string[]> {
  return invoke<string[]>("resolve_video_inputs", { inputPath });
}

export async function previewFrame(
  inputPath: string,
  settings: ProcessingSettings,
  frameIndex: number,
  previewId?: string,
): Promise<PreviewFrameResult> {
  return invoke<PreviewFrameResult>("preview_frame", {
    inputPath,
    settings,
    frameIndex,
    previewId,
  });
}

export async function getRuntimeCapabilities(): Promise<RuntimeCapabilities> {
  return invoke<RuntimeCapabilities>("get_runtime_capabilities");
}

export async function scanDvdSubtitleTracks(
  inputPaths: string[],
): Promise<DvdSubtitleTrackCandidate[]> {
  return invoke<DvdSubtitleTrackCandidate[]>("scan_dvd_subtitle_tracks", {
    inputPaths,
  });
}

export async function extractDvdSubtitleTracks(
  request: DvdSubtitleExtractRequest,
): Promise<DvdSubtitleExtractResult[]> {
  return invoke<DvdSubtitleExtractResult[]>("extract_dvd_subtitle_tracks", {
    request,
  });
}

export async function startDvdOcr(
  request: DvdOcrStartRequest,
): Promise<DvdOcrStartResult> {
  return invoke<DvdOcrStartResult>("start_dvd_ocr", { request });
}

export async function loadDvdSubImages(
  request: DvdOcrStartRequest,
): Promise<DvdOcrStartResult> {
  return invoke<DvdOcrStartResult>("load_dvd_sub_images", { request });
}

export async function ocrDvdSubLine(
  request: DvdOcrLineRequest,
): Promise<DvdOcrLine> {
  return invoke<DvdOcrLine>("ocr_dvd_sub_line", { request });
}

export async function exportDvdOcrSrt(
  request: DvdOcrExportRequest,
): Promise<string> {
  return invoke<string>("export_dvd_ocr_srt", { request });
}

export async function listOcrUserReplacements(): Promise<OcrUserReplacement[]> {
  return invoke<OcrUserReplacement[]>("list_ocr_user_replacements");
}

export async function upsertOcrUserReplacement(
  pattern: string,
  replacement: string,
): Promise<void> {
  await invoke("upsert_ocr_user_replacement", { pattern, replacement });
}

export async function recordOcrCorrection(
  originalOcr: string,
  correctedText: string,
): Promise<OcrUserReplacement[]> {
  return invoke<OcrUserReplacement[]>("record_ocr_correction", {
    originalOcr,
    correctedText,
  });
}
