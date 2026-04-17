use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Waiting,
    Processing,
    Done,
    Error,
    Paused,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessingSettings {
    pub upscale_factor: u8,
    pub realcugan_model: String,
    pub chunk_size: u32,
    pub denoise_level: i8,
    pub video_codec: String,
    pub encoder_preset: String,
    pub quality_mode: String,
    pub crf: Option<u8>,
    pub bitrate_kbps: Option<u32>,
    pub tile_size: serde_json::Value,
    pub tta_mode: bool,
    #[serde(default = "default_realcugan_gpu")]
    pub realcugan_gpu: String,
    #[serde(default)]
    pub realcugan_threads: String,
    #[serde(default = "default_final_resolution")]
    pub final_resolution: String,
    #[serde(default)]
    pub selected_audio_stream_index: Option<u32>,
    #[serde(default)]
    pub selected_subtitle_stream_index: Option<u32>,
    #[serde(default = "default_subtitle_output_format")]
    pub subtitle_output_format: String,
    #[serde(default)]
    pub preview_session_id: Option<String>,
    #[serde(default)]
    pub preview_last_frame_index: Option<u64>,
    pub copy_audio: bool,
    pub copy_subs: bool,
    pub hardware_accel: bool,
    pub auto_deinterlace: bool,
    #[serde(default = "default_deinterlace_mode")]
    pub deinterlace_mode: String,
    pub auto_crop: bool,
    pub manual_crop: Option<String>,
    pub output_dir: String,
    #[serde(default)]
    pub external_srt_path: Option<String>,
}

fn default_realcugan_gpu() -> String {
    "auto".to_string()
}

fn default_final_resolution() -> String {
    "source".to_string()
}

fn default_subtitle_output_format() -> String {
    "copy".to_string()
}

fn default_deinterlace_mode() -> String {
    "bwdif".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeCapabilities {
    pub hardware_accel_available: bool,
    pub available_hw_encoders: Vec<String>,
    pub detected_gpu_count: u32,
    pub suggested_realcugan_gpu: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueJob {
    pub id: String,
    pub input_path: String,
    pub output_path: String,
    pub status: JobStatus,
    pub progress: f32,
    pub fps: f32,
    pub extract_current: u64,
    pub extract_total: u64,
    pub upscale_current: u64,
    pub upscale_total: u64,
    pub eta_seconds: Option<u64>,
    pub error: Option<String>,
    pub settings: ProcessingSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoTrackInfo {
    pub stream_index: u32,
    pub codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f32>,
    pub frame_count: Option<u64>,
    pub color_transfer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioTrackInfo {
    pub stream_index: u32,
    pub codec: Option<String>,
    pub language: Option<String>,
    pub bitrate: Option<u64>,
    pub title: Option<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleTrackInfo {
    pub stream_index: u32,
    pub codec: Option<String>,
    pub language: Option<String>,
    pub title: Option<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoAnalysis {
    pub width: u32,
    pub height: u32,
    pub fps: f32,
    pub duration_seconds: f64,
    pub frame_count: u64,
    pub container: String,
    pub has_hdr: bool,
    pub video_tracks: Vec<VideoTrackInfo>,
    pub audio_tracks: Vec<AudioTrackInfo>,
    pub subtitle_tracks: Vec<SubtitleTrackInfo>,
}
