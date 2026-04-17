use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};

use crate::app_paths::ToolPaths;
use crate::command_utils::tokio_command;
use crate::models::{JobStatus, ProcessingSettings};

const JOB_CANCELED: &str = "__JOB_CANCELED__";

fn is_text_subtitle_codec(codec: &str) -> bool {
    matches!(
        codec,
        "subrip" | "srt" | "ass" | "ssa" | "webvtt" | "mov_text" | "text"
    )
}

async fn probe_stream_codec(tools: &ToolPaths, source_path: &Path, stream_index: u32) -> Option<String> {
    let output = tokio_command(&tools.ffprobe_exe)
        .arg("-v")
        .arg("error")
        .arg("-select_streams")
        .arg(stream_index.to_string())
        .arg("-show_entries")
        .arg("stream=codec_name")
        .arg("-of")
        .arg("default=nokey=1:noprint_wrappers=1")
        .arg(source_path)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let codec = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if codec.is_empty() {
        None
    } else {
        Some(codec)
    }
}

pub async fn remux_with_source_streams(
    tools: &ToolPaths,
    settings: &ProcessingSettings,
    source_path: &Path,
    encoded_video_path: &Path,
    output_path: &Path,
    job_id: &str,
    control_map: Arc<Mutex<HashMap<String, JobStatus>>>,
) -> Result<(), String> {
    let mut cmd = tokio_command(&tools.ffmpeg_exe);
    cmd.arg("-y")
        .arg("-i")
        .arg(encoded_video_path)
        .arg("-i")
        .arg(source_path);
    
    // Si on a un SRT externe, l'ajouter comme input supplémentaire
    let input_index_for_subs = if let Some(ref srt_path) = settings.external_srt_path {
        cmd.arg("-i").arg(srt_path);
        2 // Index de la troisième input (le SRT externe)
    } else {
        1 // Index de la deuxième input (la source vidéo)
    };
    
    cmd.arg("-map")
        .arg("0:v:0");

    if settings.copy_audio {
        if let Some(audio_stream_index) = settings.selected_audio_stream_index {
            cmd.arg("-map").arg(format!("1:{audio_stream_index}?"));
        } else {
            cmd.arg("-map").arg("1:a?");
        }
        cmd.arg("-c:a").arg("copy");
    } else {
        cmd.arg("-an");
    }

    // Gestion des sous-titres
    if let Some(ref _srt_path) = settings.external_srt_path {
        // Utiliser le SRT externe
        cmd.arg("-map").arg(format!("{input_index_for_subs}:s:0?"));
        cmd.arg("-c:s").arg("copy");
    } else if settings.copy_subs {
        // Utiliser les sous-titres de la source vidéo
        if let Some(subtitle_stream_index) = settings.selected_subtitle_stream_index {
            cmd.arg("-map").arg(format!("1:{subtitle_stream_index}?"));
            if settings.subtitle_output_format == "srt" {
                let codec = probe_stream_codec(tools, source_path, subtitle_stream_index).await;
                if codec.as_deref().map(is_text_subtitle_codec).unwrap_or(false) {
                    cmd.arg("-c:s").arg("srt");
                } else {
                    cmd.arg("-c:s").arg("copy");
                }
            } else {
                cmd.arg("-c:s").arg("copy");
            }
        } else {
            cmd.arg("-map").arg("1:s?");
            cmd.arg("-c:s").arg("copy");
        }
    }

    cmd.arg("-map_metadata")
        .arg("1")
        .arg("-map_chapters")
        .arg("1")
        .arg("-c:v")
        .arg("copy")
        .arg(output_path);

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    loop {
        let status = {
            let control = control_map.lock().await;
            control
                .get(job_id)
                .cloned()
                .unwrap_or(JobStatus::Processing)
        };

        if status == JobStatus::Canceled {
            let _ = child.kill().await;
            return Err(JOB_CANCELED.to_string());
        }

        match child.try_wait().map_err(|e| e.to_string())? {
            Some(exit) => {
                if !exit.success() {
                    return Err("FFmpeg a echoue pendant le remux".to_string());
                }
                break;
            }
            None => sleep(Duration::from_millis(300)).await,
        }
    }

    Ok(())
}
