use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::OnceLock;

use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};

use crate::app_paths::ToolPaths;
use crate::command_utils::{std_command, tokio_command};
use crate::models::{JobStatus, ProcessingSettings};

// Erreur d'annulation de job
const JOB_CANCELED: &str = "__JOB_CANCELED__";

// Cache des encodeurs FFmpeg
static ENCODERS_CACHE: OnceLock<Vec<String>> = OnceLock::new();

// Suffixes des encodeurs hardware
const HW_SUFFIXES: &[&str] = &["_nvenc", "_qsv", "_amf"];

// Mappeur d'encodeurs FFmpeg software
fn codec_to_ffmpeg(codec: &str) -> &'static str {
    match codec {
        "h264" => "libx264",
        "h265" => "libx265",
        "av1"  => "libsvtav1",
        _      => "libx265",
    }
}

// Priorité des encodeurs FFmpeg hardware
fn hw_encoder_priority(codec: &str) -> &'static [&'static str] {
    match codec {
        "h264" => &["h264_nvenc", "h264_qsv", "h264_amf"],
        "h265" => &["hevc_nvenc", "hevc_qsv", "hevc_amf"],
        "av1"  => &["av1_qsv",   "av1_amf",  "av1_nvenc"],
        _      => &[],
    }
}

// Détect des encodeurs FFmpeg
fn ffmpeg_encoders(tools: &ToolPaths) -> &'static [String] {
    ENCODERS_CACHE.get_or_init(|| {
        let Ok(out) = std_command(&tools.ffmpeg_exe)
            .args(["-hide_banner", "-encoders"])
            .output()
        else {
            return Vec::new();
        };

        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|line| {
                // Filtre les lignes qui ne sont pas des encodeurs vidéo
                let trimmed = line.trim_start();
                if !trimmed.starts_with('V') {
                    return None;
                }
                trimmed.split_whitespace().nth(1).map(str::to_owned)
            })
            .collect()
    })
}

// Détect des encodeurs FFmpeg hardware
pub fn detect_hardware_encoders(tools: &ToolPaths) -> Vec<String> {
    ffmpeg_encoders(tools)
        .iter()
        .filter(|name| HW_SUFFIXES.iter().any(|suffix| name.ends_with(suffix)))
        .cloned()
        .collect()
}

#[derive(Debug, Clone)]
struct EncoderChoice {
    // Nom de l'encodeur FFmpeg
    name: String,
    // Si c'est un encodeur hardware
    is_hw: bool,
}

impl EncoderChoice {
    fn software(codec: &str) -> Self {
        Self {
            name: codec_to_ffmpeg(codec).to_owned(),
            is_hw: false,
        }
    }
}

// Choix d'encodeur FFmpeg
fn select_encoder(tools: &ToolPaths, settings: &ProcessingSettings) -> EncoderChoice {
    if settings.hardware_accel {
        let available = ffmpeg_encoders(tools);
        for &candidate in hw_encoder_priority(&settings.video_codec) {
            if available.iter().any(|e| e == candidate) {
                return EncoderChoice {
                    name: candidate.to_owned(),
                    is_hw: true,
                };
            }
        }
    }
    EncoderChoice::software(&settings.video_codec)
}


fn encoder_attempts(tools: &ToolPaths, settings: &ProcessingSettings) -> Vec<EncoderChoice> {
    let preferred = select_encoder(tools, settings);
    let mut attempts = vec![preferred.clone()];
    if preferred.is_hw {
        attempts.push(EncoderChoice::software(&settings.video_codec));
    }
    attempts
}

// Filtre de résolution FFmpeg
fn target_resolution_filter(settings: &ProcessingSettings) -> Option<String> {
    let (w, h) = match settings.final_resolution.as_str() {
        "720p"  => (1280_u32, 720_u32),
        "1080p" => (1920_u32, 1080_u32),
        "4k"    => (3840_u32, 2160_u32),
        _       => return None,
    };
    Some(format!(
        "scale=w={w}:h={h}:force_original_aspect_ratio=decrease:flags=lanczos,\
         pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"
    ))
}

// Construit la commande FFmpeg d'encodage
fn build_encode_command(
    tools: &ToolPaths,
    settings: &ProcessingSettings,
    frames_pattern: &Path,
    fps: f32,
    output_path: &Path,
    encoder: &EncoderChoice,
) -> Command {
    let mut cmd = tokio_command(&tools.ffmpeg_exe);

    // Entrée
    cmd.args(["-y", "-hide_banner", "-loglevel", "error"])
        .arg("-framerate").arg(format!("{fps:.6}"))
        .arg("-i").arg(frames_pattern);

    // Filtre de résolution FFmpeg
    if let Some(vf) = target_resolution_filter(settings) {
        cmd.arg("-vf").arg(vf);
    }

    // Codec
    cmd.arg("-c:v").arg(&encoder.name);

    // Format de pixel
    cmd.arg("-pix_fmt")
        .arg(if encoder.is_hw { "yuv420p" } else { "yuv420p10le" });

    // Preset de l'encodeur FFmpeg
    if !encoder.is_hw {
        let preset = if encoder.name == "libsvtav1" {
            "8".to_owned()
        } else {
            settings.encoder_preset.clone()
        };
        cmd.arg("-preset").arg(preset);
    }

    // Contrôle de vitesse
    if encoder.is_hw || settings.quality_mode == "bitrate" {
        cmd.arg("-b:v")
            .arg(format!("{}k", settings.bitrate_kbps.unwrap_or(8000)));
    } else {
        cmd.arg("-crf")
            .arg(settings.crf.unwrap_or(18).to_string());
    }

    // Sortie
    cmd.arg(output_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    cmd
}

// Spawne une commande FFmpeg d'encodage et surveille sa progression, respectant la annulation de la tâche.
async fn run_encode_attempt(
    mut cmd: Command,
    job_id: &str,
    control_map: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> Result<(), String> {
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    loop {
        let status = control_map
            .lock()
            .await
            .get(job_id)
            .cloned()
            .unwrap_or(JobStatus::Processing);

        if status == JobStatus::Canceled {
            let _ = child.kill().await;
            return Err(JOB_CANCELED.to_string());
        }

        match child.try_wait().map_err(|e| e.to_string())? {
            Some(exit) if exit.success() => return Ok(()),
            Some(exit) => {
                let code = exit.code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "inconnu".to_owned());
                return Err(format!("FFmpeg a échoué (exit={code})"));
            }
            None => sleep(Duration::from_millis(300)).await,
        }
    }
}

// Encodage d'une séquence d'images PNG upscaled en un fichier vidéo
pub async fn encode_upscaled_frames(
    tools: &ToolPaths,
    settings: &ProcessingSettings,
    frames_pattern: &Path,
    fps: f32,
    output_path: &Path,
    job_id: &str,
    control_map: Arc<Mutex<HashMap<String, JobStatus>>>,
) -> Result<(), String> {
    let attempts = encoder_attempts(tools, settings);
    let last_idx = attempts.len() - 1;

    for (i, encoder) in attempts.iter().enumerate() {
        let cmd = build_encode_command(tools, settings, frames_pattern, fps, output_path, encoder);

        match run_encode_attempt(cmd, job_id, &control_map).await {
            Ok(()) => return Ok(()),

            // Annulation de la tâche est toujours terminal
            Err(e) if e == JOB_CANCELED => return Err(e),

            // Si c'est la dernière tentative, on renvoie l'erreur
            Err(e) if i == last_idx => {
                return Err(format!(
                    "FFmpeg a échoué sur tous les encodeurs (dernier: {}, {e})",
                    encoder.name
                ));
            }

            // Sinon, on enregistre l'erreur et on essaie l'encodeur suivant
            Err(e) => {
                eprintln!(
                    "[encoder] {} a échoué ({e}), tentative avec le suivant…",
                    encoder.name
                );
            }
        }
    }

    // Si aucune tentative n'a réussi, on renvoie l'erreur
    Err("Aucun encodeur disponible".to_owned())
}
