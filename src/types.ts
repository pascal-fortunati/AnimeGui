export type JobStatus =
  | "waiting"
  | "processing"
  | "done"
  | "error"
  | "paused"
  | "canceled";

export type PresetName = "Anime HD" | "Old DVD" | "High Quality" | "Custom";
export type RealcuganModel = "models-se" | "models-pro" | "models-nose";
export type UpscaleFactor = 2 | 3 | 4;
export type DenoiseLevel = -1 | 0 | 1 | 2 | 3;
export type RealcuganGpuTarget = "auto" | "cpu" | "0" | "1" | "0,1";
export type FinalResolutionPreset = "source" | "720p" | "1080p" | "4k";
export type SubtitleOutputFormat = "copy" | "srt";
export type DeinterlaceMode = "bwdif" | "yadif";

export interface ProcessingSettings {
  upscale_factor: UpscaleFactor;
  realcugan_model: RealcuganModel;
  chunk_size: 300 | 500 | 1000 | 2000;
  denoise_level: DenoiseLevel;
  video_codec: "h264" | "h265" | "av1";
  encoder_preset: string;
  quality_mode: "crf" | "bitrate";
  crf?: number;
  bitrate_kbps?: number;
  tile_size: "auto" | 100 | 200 | 400;
  tta_mode: boolean;
  realcugan_gpu: RealcuganGpuTarget;
  realcugan_threads: string;
  final_resolution: FinalResolutionPreset;
  selected_audio_stream_index?: number;
  selected_subtitle_stream_index?: number;
  subtitle_output_format: SubtitleOutputFormat;
  preview_session_id?: string;
  preview_last_frame_index?: number;
  copy_audio: boolean;
  copy_subs: boolean;
  hardware_accel: boolean;
  auto_deinterlace: boolean;
  deinterlace_mode: DeinterlaceMode;
  auto_crop: boolean;
  manual_crop?: string;
  output_dir: string;
  external_srt_path?: string;
}

export interface RuntimeCapabilities {
  hardware_accel_available: boolean;
  available_hw_encoders: string[];
  detected_gpu_count: number;
  suggested_realcugan_gpu: RealcuganGpuTarget;
}

const REALCUGAN_CAPABILITIES: Record<
  RealcuganModel,
  Partial<Record<UpscaleFactor, DenoiseLevel[]>>
> = {
  "models-se": {
    2: [-1, 0, 1, 2, 3],
    3: [-1, 0, 3],
    4: [-1, 0, 3],
  },
  "models-pro": {
    2: [-1, 0, 3],
    3: [-1, 0, 3],
  },
  "models-nose": {
    2: [-1],
  },
};

export function availableScalesForModel(model: RealcuganModel): UpscaleFactor[] {
  const values = Object.keys(REALCUGAN_CAPABILITIES[model])
    .map((value) => Number(value) as UpscaleFactor)
    .filter((value) => !Number.isNaN(value))
    .sort((a, b) => a - b);
  return values;
}

export function availableDenoiseFor(
  model: RealcuganModel,
  scale: UpscaleFactor,
): DenoiseLevel[] {
  const byScale = REALCUGAN_CAPABILITIES[model][scale];
  if (!byScale || byScale.length === 0) {
    return [];
  }
  return [...byScale];
}

export function denoiseLabel(level: DenoiseLevel): string {
  if (level === -1) {
    return "No denoise (-1)";
  }
  if (level === 0) {
    return "Conservative (0)";
  }
  return `Denoise ${level}x`;
}

export function sanitizeProcessingSettings(
  settings: ProcessingSettings,
): ProcessingSettings {
  const validScales = availableScalesForModel(settings.realcugan_model);
  const fallbackScale = validScales[0] ?? 2;
  const scale = validScales.includes(settings.upscale_factor)
    ? settings.upscale_factor
    : fallbackScale;
  const validDenoise = availableDenoiseFor(settings.realcugan_model, scale);
  const fallbackDenoise = validDenoise[0] ?? -1;
  const denoise = validDenoise.includes(settings.denoise_level)
    ? settings.denoise_level
    : fallbackDenoise;

  const sanitizedGpu = (() => {
    const value = settings.realcugan_gpu;
    if (value === "auto" || value === "cpu" || value === "0" || value === "1" || value === "0,1") {
      return value;
    }
    return "auto";
  })();
  const sanitizedThreads = settings.realcugan_threads.trim();
  const sanitizedFinalResolution = (() => {
    const value = settings.final_resolution;
    if (value === "source" || value === "720p" || value === "1080p" || value === "4k") {
      return value;
    }
    return "source";
  })();

  const sanitizedSubtitleOutputFormat = settings.subtitle_output_format === "srt"
    ? "srt"
    : "copy";
  const sanitizedDeinterlaceMode = settings.deinterlace_mode === "yadif"
    ? "yadif"
    : "bwdif";

  return {
    ...settings,
    upscale_factor: scale,
    denoise_level: denoise,
    realcugan_gpu: sanitizedGpu,
    realcugan_threads: sanitizedThreads,
    final_resolution: sanitizedFinalResolution,
    selected_audio_stream_index: settings.selected_audio_stream_index,
    selected_subtitle_stream_index: settings.selected_subtitle_stream_index,
    subtitle_output_format: sanitizedSubtitleOutputFormat,
    preview_session_id: settings.preview_session_id,
    preview_last_frame_index: settings.preview_last_frame_index,
    deinterlace_mode: sanitizedDeinterlaceMode,
  };
}

export interface QueueJob {
  id: string;
  input_path: string;
  output_path: string;
  status: JobStatus;
  progress: number;
  fps: number;
  extract_current: number;
  extract_total: number;
  upscale_current: number;
  upscale_total: number;
  eta_seconds: number | null;
  error: string | null;
  settings: ProcessingSettings;
}

export interface VideoAnalysis {
  width: number;
  height: number;
  fps: number;
  duration_seconds: number;
  frame_count: number;
  container: string;
  has_hdr: boolean;
  video_tracks: VideoTrackInfo[];
  audio_tracks: AudioTrackInfo[];
  subtitle_tracks: SubtitleTrackInfo[];
}

export interface VideoTrackInfo {
  stream_index: number;
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  frame_count?: number;
  color_transfer?: string;
}

export interface AudioTrackInfo {
  stream_index: number;
  codec?: string;
  language?: string;
  bitrate?: number;
  title?: string;
  is_default: boolean;
}

export interface SubtitleTrackInfo {
  stream_index: number;
  codec?: string;
  language?: string;
  title?: string;
  is_default: boolean;
}

export interface PreviewFrameResult {
  original_png_base64: string;
  upscaled_png_base64: string;
  detected_crop: string | null;
  applied_crop: string | null;
  frame_index: number;
  frame_total: number;
  source_width: number;
  source_height: number;
}

export interface DvdSubtitleTrackCandidate {
  input_path: string;
  stream_index: number;
  codec: string;
  language?: string;
  title?: string;
  is_default: boolean;
}

export interface DvdSubtitleExtractRequest {
  input_paths: string[];
  output_dir: string;
}

export interface DvdSubtitleExtractResult {
  input_path: string;
  stream_index: number;
  idx_path: string;
  sub_path: string;
  success: boolean;
  error?: string;
}

export interface DvdOcrStartRequest {
  idx_path: string;
  output_dir: string;
  language: string;
  max_images?: number;
  ocr_upscale_factor?: 2 | 3;
}

export interface DvdOcrLineRequest {
  id: number;
  image_path: string;
  start_ms: number;
  end_ms: number;
  language: string;
}

export interface DvdOcrLine {
  id: number;
  image_path: string;
  image_data_url: string;
  start_ms: number;
  end_ms: number;
  ocr_text: string;
  confidence: number;
  needs_manual: boolean;
  unknown_tokens: string[];
}

export interface DvdOcrStartResult {
  lines: DvdOcrLine[];
}

export interface DvdOcrExportRequest {
  output_srt_path: string;
  lines: DvdOcrLine[];
}

export interface OcrUserReplacement {
  pattern: string;
  replacement: string;
}

export const DEFAULT_SETTINGS: ProcessingSettings = {
  upscale_factor: 2,
  realcugan_model: "models-se",
  chunk_size: 1000,
  denoise_level: 3,
  video_codec: "h265",
  encoder_preset: "medium",
  quality_mode: "crf",
  crf: 18,
  bitrate_kbps: undefined,
  tile_size: "auto",
  tta_mode: false,
  realcugan_gpu: "auto",
  realcugan_threads: "",
  final_resolution: "source",
  selected_audio_stream_index: undefined,
  selected_subtitle_stream_index: undefined,
  subtitle_output_format: "copy",
  preview_session_id: undefined,
  preview_last_frame_index: undefined,
  copy_audio: true,
  copy_subs: true,
  hardware_accel: false,
  auto_deinterlace: true,
  deinterlace_mode: "bwdif",
  auto_crop: true,
  manual_crop: undefined,
  output_dir: "",
};
