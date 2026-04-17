use std::path::Path;
use crate::app_paths::ToolPaths;
use crate::command_utils::tokio_command;
use crate::models::{AudioTrackInfo, SubtitleTrackInfo, VideoAnalysis, VideoTrackInfo};

fn parse_fps(raw: &str) -> Option<f32> {
    let parts: Vec<&str> = raw.split('/').collect();
    if parts.len() == 2 {
        let num = parts[0].parse::<f32>().ok()?;
        let den = parts[1].parse::<f32>().ok()?;
        if den.abs() < f32::EPSILON {
            return None;
        }
        Some(num / den)
    } else {
        raw.parse::<f32>().ok()
    }
}

async fn probe_exact_frame_count(input_path: &Path, tools: &ToolPaths) -> Option<u64> {
    let output = tokio_command(&tools.ffprobe_exe)
        .arg("-v")
        .arg("error")
        .arg("-select_streams")
        .arg("v:0")
        .arg("-count_frames")
        .arg("-show_entries")
        .arg("stream=nb_read_frames")
        .arg("-of")
        .arg("default=nokey=1:noprint_wrappers=1")
        .arg(input_path)
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find_map(|line| line.trim().parse::<u64>().ok())
        .filter(|count| *count > 0)
}

async fn analyze_video_with_options(
    input_path: &Path,
    tools: &ToolPaths,
    allow_exact_frame_probe: bool,
) -> Result<VideoAnalysis, String> {
    let output = tokio_command(&tools.ffprobe_exe)
        .arg("-v")
        .arg("error")
        .arg("-show_streams")
        .arg("-show_format")
        .arg("-of")
        .arg("json")
        .arg(input_path)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("JSON ffprobe invalide: {e}"))?;
    let streams = json["streams"]
        .as_array()
        .ok_or_else(|| "ffprobe: streams absents".to_string())?;
    let format = &json["format"];

    let mut width = 0;
    let mut height = 0;
    let mut fps = 0.0;
    let mut frame_count = 0_u64;
    let mut has_hdr = false;
    let mut video_tracks = Vec::new();
    let mut audio_tracks = Vec::new();
    let mut subtitle_tracks = Vec::new();

    for stream in streams {
        let stream_index = stream["index"].as_u64().unwrap_or(0) as u32;
        let is_default = stream["disposition"]["default"].as_u64().unwrap_or(0) == 1;
        let title = stream["tags"]["title"].as_str().map(ToString::to_string);
        match stream["codec_type"].as_str().unwrap_or_default() {
            "video" => {
                let track_width = stream["width"].as_u64().unwrap_or(0) as u32;
                let track_height = stream["height"].as_u64().unwrap_or(0) as u32;
                let track_fps = parse_fps(stream["r_frame_rate"].as_str().unwrap_or("0"));
                let track_frame_count = stream["nb_frames"]
                    .as_str()
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(0);
                let color_transfer = stream["color_transfer"].as_str().map(ToString::to_string);

                video_tracks.push(VideoTrackInfo {
                    stream_index,
                    codec: stream["codec_name"].as_str().map(ToString::to_string),
                    width: Some(track_width),
                    height: Some(track_height),
                    fps: track_fps,
                    frame_count: if track_frame_count > 0 {
                        Some(track_frame_count)
                    } else {
                        None
                    },
                    color_transfer,
                });

                if width == 0 {
                    width = track_width;
                    height = track_height;
                    fps = track_fps.unwrap_or(0.0);
                    frame_count = track_frame_count;
                }

                has_hdr = has_hdr || stream["color_transfer"]
                    .as_str()
                    .map(|v| v.contains("smpte2084") || v.contains("arib-std-b67"))
                    .unwrap_or(false);
            }
            "audio" => {
                audio_tracks.push(AudioTrackInfo {
                    stream_index,
                    codec: stream["codec_name"].as_str().map(ToString::to_string),
                    language: stream["tags"]["language"].as_str().map(ToString::to_string),
                    bitrate: stream["bit_rate"]
                        .as_str()
                        .and_then(|v| v.parse::<u64>().ok()),
                    title: title.clone(),
                    is_default,
                });
            }
            "subtitle" => {
                subtitle_tracks.push(SubtitleTrackInfo {
                    stream_index,
                    codec: stream["codec_name"].as_str().map(ToString::to_string),
                    language: stream["tags"]["language"].as_str().map(ToString::to_string),
                    title,
                    is_default,
                });
            }
            _ => {}
        }
    }

    let duration_seconds = format["duration"]
        .as_str()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    let container = format["format_name"]
        .as_str()
        .unwrap_or_default()
        .to_string();

    if allow_exact_frame_probe && frame_count == 0 {
        if let Some(exact) = probe_exact_frame_count(input_path, tools).await {
            frame_count = exact;
        }
    }

    Ok(VideoAnalysis {
        width,
        height,
        fps,
        duration_seconds,
        frame_count,
        container,
        has_hdr,
        video_tracks,
        audio_tracks,
        subtitle_tracks,
    })
}

#[allow(dead_code)]
pub async fn analyze_video(input_path: &Path, tools: &ToolPaths) -> Result<VideoAnalysis, String> {
    analyze_video_with_options(input_path, tools, true).await
}

pub async fn analyze_video_fast(
    input_path: &Path,
    tools: &ToolPaths,
) -> Result<VideoAnalysis, String> {
    analyze_video_with_options(input_path, tools, false).await
}
