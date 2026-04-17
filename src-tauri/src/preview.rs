use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::analyzer::analyze_video_fast;
use crate::app_paths::{resolve_project_root, ToolPaths};
use crate::command_utils::tokio_command;
use crate::models::ProcessingSettings;
use crate::upscaler::{apply_realcugan_runtime_args, validate_realcugan_settings};

// Résultat d'une frame de prévisualisation
#[derive(Debug, Clone, Serialize)]
pub struct PreviewFrameResult {
    pub original_png_base64: String,
    pub upscaled_png_base64: String,
    pub detected_crop: Option<String>,
    pub applied_crop: Option<String>,
    pub frame_index: u64,
    pub frame_total: u64,
    pub source_width: u32,
    pub source_height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PreviewMeta {
    source_path: String,
    frame_total: u64,
    source_width: u32,
    source_height: u32,
    #[serde(default)]
    source_fps: f32,
}
static PARITY_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

// Chemins de fichiers de prévisualisation
struct PreviewPaths {
    meta:           std::path::PathBuf,
    cache:          std::path::PathBuf,
    raw:            std::path::PathBuf,
    upscale_input:  std::path::PathBuf,
    upscaled:       std::path::PathBuf,
}

impl PreviewPaths {
    fn new(root: std::path::PathBuf) -> Self {
        Self {
            meta:          root.join("meta.json"),
            cache:         root.join("cache"),
            raw:           root.join("raw"),
            upscale_input: root.join("upscale_input"),
            upscaled:      root.join("upscaled"),
        }
    }

    async fn create_dirs(&self) -> Result<(), String> {
        for dir in [&self.cache, &self.raw, &self.upscale_input, &self.upscaled] {
            fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn upscale_input_frame(&self) -> std::path::PathBuf { self.upscale_input.join("frame_00000001.png") }
    fn upscaled_frame(&self)      -> std::path::PathBuf { self.upscaled.join("frame_00000001.png") }
    fn upscaled_cropped(&self)    -> std::path::PathBuf { self.upscaled.join("frame_00000001_crop.png") }

    fn cache_original(&self, key: &str) -> std::path::PathBuf { self.cache.join(format!("{key}_orig.png")) }
    fn cache_upscaled(&self, key: &str) -> std::path::PathBuf { self.cache.join(format!("{key}_up.png")) }
}

// Normalise une chaîne de croix en `crop=W:H:X:Y` ou renvoie `None` si la chaîne est vide ou non reconnaissable
fn normalize_crop_filter(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("crop=") {
        return Some(trimmed.to_string());
    }
    // Si la chaîne ne commence pas par "crop=", on vérifie si c'est une notation "W:H:X:Y"
    let all_numeric = trimmed.split(':').count() == 4
        && trimmed.split(':').all(|p| p.parse::<u32>().is_ok());
    if all_numeric {
        return Some(format!("crop={trimmed}"));
    }
    None
}

// Parse une chaîne de croix en `crop=W:H:X:Y`
fn parse_crop_values(raw: &str) -> Option<(u32, u32, u32, u32)> {
    let body = raw.strip_prefix("crop=").unwrap_or(raw);
    let parts: Vec<&str> = body.split(':').collect();
    if parts.len() != 4 {
        return None;
    }
    let [w, h, x, y] = [
        parts[0].parse::<u32>().ok()?,
        parts[1].parse::<u32>().ok()?,
        parts[2].parse::<u32>().ok()?,
        parts[3].parse::<u32>().ok()?,
    ];
    Some((w, h, x, y))
}

// Retourne la croix à appliquer, préférant la croix manuelle
fn effective_crop(settings: &ProcessingSettings) -> Option<String> {
    settings.manual_crop.as_deref().and_then(normalize_crop_filter)
}

// Extrait la valeur de la taille de tuile d'une valeur JSON, renvoyant "0" par défaut
fn tile_value(tile_size: &serde_json::Value) -> String {
    match tile_size {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.as_i64().unwrap_or(0).to_string(),
        _ => "0".to_string(),
    }
}

// Nettoie une chaîne de scope de prévisualisation pour l'utiliser comme nom de dossier
fn sanitize_scope(raw: &str) -> String {
    raw.replace(['\\', '/', ':', ' '], "_")
}

// Charge ou crée le fichier meta.json pour un chemin d'entrée donné
async fn load_or_create_meta(
    paths: &PreviewPaths,
    input_path: &Path,
    tools: &ToolPaths,
) -> Result<PreviewMeta, String> {
    // Essayer de charger le fichier meta.json
    if let Ok(raw) = fs::read_to_string(&paths.meta).await {
        if let Ok(meta) = serde_json::from_str::<PreviewMeta>(&raw) {
            if meta.source_path == input_path.to_string_lossy().as_ref() {
                return Ok(meta);
            }
        }
    }

    // Si le fichier meta.json n'a pas été trouvé, analyser le vidéo
    let analysis = analyze_video_fast(input_path, tools).await?;
    let frame_total = if analysis.frame_count > 0 {
        analysis.frame_count
    } else if analysis.fps > 0.0 && analysis.duration_seconds > 0.0 {
        (analysis.fps as f64 * analysis.duration_seconds).round() as u64
    } else {
        1
    };

    let meta = PreviewMeta {
        source_path: input_path.to_string_lossy().into_owned(),
        frame_total,
        source_width:  analysis.width,
        source_height: analysis.height,
        source_fps: analysis.fps,
    };
    let json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    fs::write(&paths.meta, json).await.map_err(|e| e.to_string())?;
    Ok(meta)
}

// Construit une clé de cache pour un frame donné
fn build_cache_key(
    input_path: &Path,
    frame_index: u64,
    settings: &ProcessingSettings,
    applied_crop: &Option<String>,
) -> String {
    let mut h = DefaultHasher::new();
    input_path.to_string_lossy().hash(&mut h);
    frame_index.hash(&mut h);
    settings.upscale_factor.hash(&mut h);
    settings.denoise_level.hash(&mut h);
    settings.realcugan_model.hash(&mut h);
    settings.tta_mode.hash(&mut h);
    settings.auto_deinterlace.hash(&mut h);
    settings.deinterlace_mode.hash(&mut h);
    applied_crop.hash(&mut h);
    format!("{:x}", h.finish())
}

// Déecte la parité de l'interlacement d'un vidéo
async fn detect_deinterlace_parity(tools: &ToolPaths, input_path: &Path) -> String {
    let output = tokio_command(&tools.ffprobe_exe)
        .arg("-v")
        .arg("error")
        .arg("-select_streams")
        .arg("v:0")
        .arg("-show_entries")
        .arg("stream=field_order")
        .arg("-of")
        .arg("default=noprint_wrappers=1:nokey=1")
        .arg(input_path)
        .output()
        .await;
    let Ok(output) = output else {
        return "auto".to_string();
    };
    if !output.status.success() {
        return "auto".to_string();
    }
    let field_order = String::from_utf8_lossy(&output.stdout).trim().to_lowercase();
    match field_order.as_str() {
        "tt" | "tb" => "tff".to_string(),
        "bb" | "bt" => "bff".to_string(),
        _ => "auto".to_string(),
    }
}

fn build_deinterlace_filter(settings: &ProcessingSettings, parity: &str) -> String {
    let mode = settings.deinterlace_mode.trim().to_ascii_lowercase();
    if mode == "yadif" {
        format!("yadif=mode=send_frame:parity={parity}:deint=all")
    } else {
        format!("bwdif=mode=send_frame:parity={parity}:deint=all")
    }
}

// Extrait un frame brut d'un vidéo
async fn extract_raw_frame(
    tools: &ToolPaths,
    input_path: &Path,
    frame_index: u64,
    source_fps: f32,
    settings: &ProcessingSettings,
    dest: &Path,
) -> Result<(), String> {
    let mut filters: Vec<String> = Vec::new();
    if settings.auto_deinterlace {
        let parity = detect_deinterlace_parity_cached(tools, input_path).await;
        filters.push(build_deinterlace_filter(settings, &parity));
    }

    let mut cmd = tokio_command(&tools.ffmpeg_exe);
    cmd.arg("-y");
    if source_fps > 0.0 && frame_index > 0 {
        let seek = frame_index as f64 / source_fps as f64;
        cmd.arg("-ss").arg(format!("{seek:.6}"));
    }
    cmd.arg("-i").arg(input_path);
    if !filters.is_empty() {
        cmd.arg("-vf").arg(filters.join(","));
    }
    let status = cmd
        .args(["-frames:v", "1"])
        .arg(dest)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !status.status.success() {
        return Err(String::from_utf8_lossy(&status.stderr).into_owned());
    }
    Ok(())
}

// Exécute l'upscale d'un vidéo
async fn run_upscaler(
    tools: &ToolPaths,
    settings: &ProcessingSettings,
    input_dir: &Path,
    output_dir: &Path,
) -> Result<(), String> {
    let mut cmd = tokio_command(&tools.realcugan_exe);
    cmd.current_dir(&tools.realcugan_dir)
        .arg("-i").arg(input_dir)
        .arg("-o").arg(output_dir)
        .arg("-s").arg(settings.upscale_factor.to_string())
        .arg("-n").arg(settings.denoise_level.to_string())
        .arg("-m").arg(settings.realcugan_model.as_str())
        .arg("-t").arg(tile_value(&settings.tile_size));

    apply_realcugan_runtime_args(&mut cmd, settings);
    if settings.tta_mode {
        cmd.arg("-x");
    }

    let output = cmd.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(())
}

// Applique un filtre de coupure à un frame upscaled
async fn crop_upscaled_frame(
    tools: &ToolPaths,
    src: &Path,
    dest: &Path,
    crop: &str,
    upscale_factor: u8,
) -> Result<(), String> {
    let (w, h, x, y) = parse_crop_values(crop)
        .ok_or_else(|| format!("Invalid crop value: {crop}"))?;

    let f = u32::from(upscale_factor.max(1));
    let filter = format!("crop={}:{}:{}:{}", w * f, h * f, x * f, y * f);

    let output = tokio_command(&tools.ffmpeg_exe)
        .args(["-y", "-i"])
        .arg(src)
        .args(["-vf", &filter, "-frames:v", "1"])
        .arg(dest)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(())
}

// Génère un frame de preview d'une vidéo
pub async fn generate_preview_frame(
    tools: &ToolPaths,
    input_path: &Path,
    settings: &ProcessingSettings,
    requested_frame: u64,
    preview_id: Option<&str>,
) -> Result<PreviewFrameResult, String> {
    validate_realcugan_settings(settings)?;

    // Résoud les chemins de travail
    let scope = sanitize_scope(
        preview_id
            .or(settings.preview_session_id.as_deref())
            .unwrap_or("default"),
    );
    let root = resolve_project_root()?
        .join("temp_jobs")
        .join("preview")
        .join(scope);
    let paths = PreviewPaths::new(root);
    paths.create_dirs().await?;

    // Charge (ou crée) les métadonnées de la vidéo
    let meta = load_or_create_meta(&paths, input_path, tools).await?;
    let frame_total = meta.frame_total.max(1);
    let frame_index = requested_frame.min(frame_total.saturating_sub(1));

    // Détermine le crop à appliquer
    let applied_crop = effective_crop(settings);

    // Vérifie le cache en mémoire si le frame est déjà généré
    let cache_key = build_cache_key(input_path, frame_index, settings, &applied_crop);
    let cache_orig = paths.cache_original(&cache_key);
    let cache_up   = paths.cache_upscaled(&cache_key);

    if cache_orig.exists() && cache_up.exists() {
        let orig_bytes = fs::read(&cache_orig).await.map_err(|e| e.to_string())?;
        let up_bytes   = fs::read(&cache_up).await.map_err(|e| e.to_string())?;
        return Ok(build_result(
            orig_bytes, up_bytes, &meta, frame_index, frame_total, applied_crop,
        ));
    }
    
    // Cache le frame en mémoire si il n'est pas déjà généré
    let raw_frame       = paths.upscale_input_frame();
    let upscaled_frame  = paths.upscaled_frame();
    let cropped_frame   = paths.upscaled_cropped();

    for f in [&raw_frame, &upscaled_frame, &cropped_frame] {
        let _ = fs::remove_file(f).await;
    }

    // 1. Extraire le frame d'origine
    extract_raw_frame(
        tools,
        input_path,
        frame_index,
        meta.source_fps,
        settings,
        &raw_frame,
    )
    .await?;

    // 2. L'upsaler
    run_upscaler(tools, settings, &paths.upscale_input, &paths.upscaled).await?;

    // 3. Applique le filtre de crop si nécessaire
    let final_upscaled = if let Some(ref crop) = applied_crop {
        crop_upscaled_frame(tools, &upscaled_frame, &cropped_frame, crop, settings.upscale_factor).await?;
        cropped_frame.clone()
    } else {
        upscaled_frame.clone()
    };

    // 4. Lit les résultats et remplit le cache en mémoire
    let orig_bytes = fs::read(&raw_frame).await.map_err(|e| e.to_string())?;
    let up_bytes   = fs::read(&final_upscaled).await.map_err(|e| e.to_string())?;

    let _ = fs::copy(&raw_frame, &cache_orig).await;
    let _ = fs::copy(&final_upscaled, &cache_up).await;

    Ok(build_result(orig_bytes, up_bytes, &meta, frame_index, frame_total, applied_crop))
}

// Construit le résultat de preview
fn build_result(
    orig_bytes: Vec<u8>,
    up_bytes: Vec<u8>,
    meta: &PreviewMeta,
    frame_index: u64,
    frame_total: u64,
    applied_crop: Option<String>,
) -> PreviewFrameResult {
    PreviewFrameResult {
        original_png_base64: BASE64.encode(orig_bytes),
        upscaled_png_base64: BASE64.encode(up_bytes),
        detected_crop: None,
        applied_crop,
        frame_index,
        frame_total,
        source_width:  meta.source_width,
        source_height: meta.source_height,
    }
}

async fn detect_deinterlace_parity_cached(tools: &ToolPaths, input_path: &Path) -> String {
    let key = input_path.to_string_lossy().to_string();
    let cache = PARITY_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(value) = guard.get(&key) {
            return value.clone();
        }
    }
    let detected = detect_deinterlace_parity(tools, input_path).await;
    if let Ok(mut guard) = cache.lock() {
        guard.insert(key, detected.clone());
    }
    detected
}
