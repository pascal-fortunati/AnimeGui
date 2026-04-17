use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use tokio::fs;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};

use crate::analyzer::analyze_video_fast;
use crate::app_paths::{resolve_project_root, ToolPaths};
use crate::command_utils::{std_command, tokio_command};
use crate::encoder::encode_upscaled_frames;
use crate::models::{JobStatus, QueueJob};
use crate::monitor::{emit_log, emit_status};
use crate::remuxer::remux_with_source_streams;
use crate::upscaler::{resolve_realcugan_runtime, upscale_directory, JOB_CANCELED, JOB_PAUSED};

// Erreur d'annulation de job
pub const JOB_CANCELED_ERR: &str = "__JOB_CANCELED__";

// Chemin de fichier temporaire pour les jobs en cours
fn temp_root() -> Result<PathBuf, String> {
    Ok(resolve_project_root()?.join("temp_jobs"))
}

// Chemins d'accès au système de fichiers pour une seule exécution de pipeline
struct PipelinePaths {
    base:         PathBuf,
    segments_dir: PathBuf,
    concat_list:  PathBuf,
    encoded:      PathBuf,
    final_output: PathBuf,
}

// Implémentation de PipelinePaths
impl PipelinePaths {
    fn new(job: &QueueJob, source_path: &Path) -> Result<Self, String> {
        let base         = temp_root()?.join(&job.id);
        let output_dir   = PathBuf::from(&job.settings.output_dir);
        let output_name  = format!("{}_upscaled.mkv", filename_stem(source_path));
        Ok(Self {
            segments_dir: base.join("segments"),
            concat_list:  base.join("segments.txt"),
            encoded:      base.join("encoded_video.mkv"),
            final_output: output_dir.join(output_name),
            base,
        })
    }

    fn chunk_dir(&self, chunk_number: u64) -> PathBuf {
        self.base.join(format!("chunk_{chunk_number:05}"))
    }

    fn segment_path(&self, chunk_number: u64) -> PathBuf {
        self.segments_dir.join(format!("part_{chunk_number:05}.mkv"))
    }
}

// Obtenir le nom de fichier sans extension
fn filename_stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "output".to_owned())
}

fn estimate_total_frames(frame_count: u64, fps: f32, duration_seconds: f64) -> u64 {
    if frame_count > 0 {
        return frame_count;
    }
    if fps > 0.0 && duration_seconds > 0.0 {
        return (fps as f64 * duration_seconds).round() as u64;
    }
    1
}

// Taille de chunk sans autoriser — seules les valeurs autorisées sont acceptées.
fn sanitized_chunk_size(raw: u32) -> u64 {
    match raw {
        300 | 500 | 1000 | 2000 => raw as u64,
        _ => 1000,
    }
}

// Normaliser une chaîne de croix brute en `crop=W:H:X:Y` ou retourner None.
fn normalize_crop_filter(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("crop=") {
        return Some(trimmed.to_owned());
    }
    let all_numeric = trimmed.split(':').count() == 4
        && trimmed.split(':').all(|p| p.parse::<u32>().is_ok());
    if all_numeric {
        return Some(format!("crop={trimmed}"));
    }
    None
}

// Compter les fichiers `.png` directement dans `dir` (insensible à la casse).
async fn count_png_files(dir: &Path) -> Result<u64, String> {
    let mut count = 0u64;
    let mut entries = fs::read_dir(dir).await.map_err(|e| e.to_string())?;
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let is_png = entry
            .path()
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("png"))
            .unwrap_or(false);
        if is_png {
            count += 1;
        }
    }
    Ok(count)
}

// Obtenir le statut actuel de la tâche
// Retourner Processing par défaut si l'entrée est absente.
async fn job_status(
    control_map: &Arc<Mutex<HashMap<String, JobStatus>>>,
    job_id: &str,
) -> JobStatus {
    control_map
        .lock()
        .await
        .get(job_id)
        .cloned()
        .unwrap_or(JobStatus::Processing)
}

// Attend que la tâche n'est plus plus en pause, en gérant les signaux de annulation.
// Émet des événements d'état et de journal.
async fn wait_while_paused(
    app: &tauri::AppHandle,
    job: &mut QueueJob,
    control_map: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> Result<(), String> {
    loop {
        match job_status(control_map, &job.id).await {
            JobStatus::Canceled => {
                job.status = JobStatus::Canceled;
                emit_status(app, job);
                return Err(JOB_CANCELED_ERR.to_owned());
            }
            JobStatus::Paused => {
                if job.status != JobStatus::Paused {
                    job.status = JobStatus::Paused;
                    emit_status(app, job);
                    emit_log(app, format!("[{}] Pause demandée", job.id));
                }
                sleep(Duration::from_millis(250)).await;
            }
            _ => {
                if job.status == JobStatus::Paused {
                    job.status = JobStatus::Processing;
                    emit_status(app, job);
                    emit_log(app, format!("[{}] Reprise du traitement", job.id));
                }
                return Ok(());
            }
        }
    }
}

// Lancer un processus FFmpeg et surveiller sa sortie, en tantant qu'elle n'est pas annulée.
async fn run_ffmpeg_cancelable(
    app: &tauri::AppHandle,
    job: &mut QueueJob,
    control_map: &Arc<Mutex<HashMap<String, JobStatus>>>,
    mut command: Command,
    step: &str,
) -> Result<(), String> {
    let mut child = command.spawn().map_err(|e| e.to_string())?;

    loop {
        match job_status(control_map, &job.id).await {
            JobStatus::Canceled => {
                let _ = child.kill().await;
                job.status = JobStatus::Canceled;
                emit_status(app, job);
                return Err(JOB_CANCELED_ERR.to_owned());
            }
            _ => {}
        }

        match child.try_wait().map_err(|e| e.to_string())? {
            Some(exit) if exit.success() => return Ok(()),
            Some(_) => return Err(format!("FFmpeg a échoué pendant {step}")),
            None => sleep(Duration::from_millis(250)).await,
        }
    }
}

// Extraire un segment de frames de `input_path` et les écrire dans `output_pattern`
async fn extract_frames_chunk(
    app: &tauri::AppHandle,
    job: &mut QueueJob,
    control_map: &Arc<Mutex<HashMap<String, JobStatus>>>,
    tools: &ToolPaths,
    input_path: &Path,
    start_frame: u64,
    end_frame: u64,
    output_pattern: &Path,
    deinterlace_filter: Option<&str>,
    crop_filter: Option<&str>,
) -> Result<(), String> {
    let output_dir = output_pattern
        .parent()
        .ok_or("Impossible de déterminer le dossier de frames extraites")?;

    let target = end_frame.saturating_sub(start_frame).saturating_add(1);
    job.extract_current = 0;
    job.extract_total = target;
    emit_status(app, job);

    // Construire la chaine de filtres
    let mut filters = vec![format!("select=between(n\\,{start_frame}\\,{end_frame})")];
    if let Some(deint) = deinterlace_filter {
        filters.push(deint.to_owned());
    }
    if let Some(crop) = crop_filter {
        filters.push(crop.to_owned());
    }
    emit_log(
        app,
        format!("[{}] Extract filters: {}", job.id, filters.join(",")),
    );

    let mut cmd = tokio_command(&tools.ffmpeg_exe);
    cmd.args(["-y", "-i"])
        .arg(input_path)
        .args(["-vf", &filters.join(",")])
        .args(["-vsync", "0"])
        .arg(output_pattern);

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut last_count = 0u64;

    loop {
        match job_status(control_map, &job.id).await {
            JobStatus::Canceled => {
                let _ = child.kill().await;
                return Err(JOB_CANCELED_ERR.to_owned());
            }
            _ => {}
        }

        match child.try_wait().map_err(|e| e.to_string())? {
            Some(exit) if exit.success() => {
                let extracted = count_png_files(output_dir).await?;
                job.extract_current = extracted;
                job.extract_total = extracted;
                emit_status(app, job);
                return Ok(());
            }
            Some(_) => return Err("FFmpeg a échoué pendant l'extraction".to_owned()),
            None => {
                let extracted = count_png_files(output_dir).await?;
                if extracted > last_count {
                    last_count = extracted;
                    job.extract_current = extracted;
                    emit_status(app, job);
                }
                sleep(Duration::from_millis(250)).await;
            }
        }
    }
}

async fn detect_bwdif_parity(tools: &ToolPaths, input_path: &Path) -> String {
    let output = std_command(&tools.ffprobe_exe)
        .arg("-v")
        .arg("error")
        .arg("-select_streams")
        .arg("v:0")
        .arg("-show_entries")
        .arg("stream=field_order")
        .arg("-of")
        .arg("default=noprint_wrappers=1:nokey=1")
        .arg(input_path)
        .output();
    let Ok(output) = output else {
        return "auto".to_owned();
    };
    if !output.status.success() {
        return "auto".to_owned();
    }
    let field_order = String::from_utf8_lossy(&output.stdout).trim().to_lowercase();
    match field_order.as_str() {
        "tt" | "tb" => "tff".to_owned(),
        "bb" | "bt" => "bff".to_owned(),
        _ => "auto".to_owned(),
    }
}

fn build_deinterlace_filter(settings: &crate::models::ProcessingSettings, parity: &str) -> String {
    let mode = settings.deinterlace_mode.trim().to_ascii_lowercase();
    if mode == "yadif" {
        format!("yadif=mode=send_frame:parity={parity}:deint=all")
    } else {
        format!("bwdif=mode=send_frame:parity={parity}:deint=all")
    }
}

// Concaténer les segments de vidéo listés dans `list_file` dans un seul fichier de sortie
// en utilisant FFmpeg's concat demuxer.
async fn concat_segments(
    app: &tauri::AppHandle,
    job: &mut QueueJob,
    control_map: &Arc<Mutex<HashMap<String, JobStatus>>>,
    tools: &ToolPaths,
    list_file: &Path,
    output_path: &Path,
) -> Result<(), String> {
    let mut cmd = tokio_command(&tools.ffmpeg_exe);
    cmd.args(["-y", "-f", "concat", "-safe", "0", "-i"])
        .arg(list_file)
        .args(["-c", "copy"])
        .arg(output_path);

    run_ffmpeg_cancelable(app, job, control_map, cmd, "concat").await
}

// Accumulator de throughput d'upscale utilisé pour les estimations de FPS et ETA.
struct ThroughputAccum {
    frames: u64,
    seconds: f64,
}
// Implémentation de l'accumulator de throughput d'upscale
impl ThroughputAccum {
    fn new() -> Self {
        Self { frames: 0, seconds: 0.0 }
    }

    // Enregistre un chunk terminé (ou partiellement terminé) et met à jour les champs `fps` et `eta_seconds` du job.
    fn record(&mut self, job: &mut QueueJob, total_frames: u64, frames: u64, elapsed: f64) {
        if elapsed <= 0.0 {
            return;
        }
        self.frames  = self.frames.saturating_add(frames);
        self.seconds += elapsed;

        let fps = self.frames as f64 / self.seconds;
        job.fps = fps as f32;

        if job.fps.is_finite() && job.fps > 0.0 {
            let remaining = total_frames.saturating_sub(self.frames);
            job.eta_seconds = Some((remaining as f64 / fps).ceil() as u64);
        }
    }
}

// L'upscale d'un segment de frames
async fn upscale_chunk(
    app: &tauri::AppHandle,
    job: &mut QueueJob,
    control_map: &Arc<Mutex<HashMap<String, JobStatus>>>,
    tools: &ToolPaths,
    raw_dir: &Path,
    upscaled_dir: &Path,
    extracted_count: u64,
    total_frames: u64,
    throughput: &mut ThroughputAccum,
) -> Result<u64, String> {
    loop {
        let settings      = job.settings.clone();
        let job_id        = job.id.clone();
        let (gpu, threads) = resolve_realcugan_runtime(&settings);

        let thread_display = if threads.trim().is_empty() {
            "default(1:2:2)".to_owned()
        } else {
            threads.clone()
        };

        emit_log(
            app,
            format!(
                "[{}] Upscale > model={} scale={} denoise={} tile={} gpu={} threads={}",
                job.id,
                settings.realcugan_model,
                settings.upscale_factor,
                settings.denoise_level,
                settings.tile_size,
                gpu,
                thread_display
            ),
        );

        job.upscale_current = 0;
        job.upscale_total   = extracted_count;
        emit_status(app, job);

        let start              = Instant::now();
        let mut last_count     = 0u64;
        let mut last_elapsed   = 0.0f64;

        let result = upscale_directory(
            tools,
            &settings,
            raw_dir,
            upscaled_dir,
            &job_id,
            control_map.clone(),
            |count, elapsed| {
                last_elapsed = elapsed;
                if count > last_count {
                    last_count = count;
                    job.upscale_current = count;
                    job.upscale_total   = extracted_count;
                }
                if elapsed > 0.0 {
                    // Estimation de FPS en temps réel
                    let total_done = throughput.frames.saturating_add(count);
                    let total_secs = throughput.seconds + elapsed;
                    let live_fps   = total_done as f64 / total_secs;
                    job.fps        = live_fps as f32;
                    if job.fps.is_finite() && job.fps > 0.0 {
                        let remaining = total_frames.saturating_sub(total_done);
                        job.eta_seconds = Some((remaining as f64 / live_fps).ceil() as u64);
                    }
                }
                emit_status(app, job);
            },
        )
        .await;

        let elapsed = if last_elapsed > 0.0 {
            last_elapsed
        } else {
            start.elapsed().as_secs_f64()
        };

        match result {
            Ok(()) => {
                job.upscale_current = extracted_count;
                job.upscale_total   = extracted_count;
                throughput.record(job, total_frames, extracted_count, elapsed);
                return Ok(extracted_count);
            }

            Err(e) if e == JOB_PAUSED => {
                let paused_frames = last_count.min(extracted_count);
                throughput.record(job, total_frames, paused_frames, elapsed);
                emit_log(app, format!("[{}] Pause appliquée (upscale chunk)", job.id));
                // Attendre la reprise du job
                wait_while_paused(app, job, control_map).await?;
            }

            Err(e) if e == JOB_CANCELED => return Err(JOB_CANCELED_ERR.to_owned()),

            Err(e) => return Err(e),
        }
    }
}

// Exécution de pipeline pour un job
pub async fn run_job_pipeline(
    app: &tauri::AppHandle,
    tools: &ToolPaths,
    job: &mut QueueJob,
    control_map: Arc<Mutex<HashMap<String, JobStatus>>>,
) -> Result<(), String> {
    let source_path  = PathBuf::from(&job.input_path);
    let analyze_started = Instant::now();
    let analysis     = analyze_video_fast(&source_path, tools).await?;
    emit_log(
        app,
        format!(
            "[{}] Analyse rapide terminée en {:.2}s",
            job.id,
            analyze_started.elapsed().as_secs_f64()
        ),
    );
    let paths        = PipelinePaths::new(job, &source_path)?;
    let chunk_size   = sanitized_chunk_size(job.settings.chunk_size);
    let total_frames = estimate_total_frames(
        analysis.frame_count,
        analysis.fps,
        analysis.duration_seconds,
    );
    let estimated_chunks = total_frames.div_ceil(chunk_size);
    let mut throughput   = ThroughputAccum::new();
    let mut chunk_videos: Vec<PathBuf> = Vec::new();

    // Préparation des dossiers de sortie
    let output_dir = PathBuf::from(&job.settings.output_dir);
    for dir in [&paths.segments_dir, &output_dir] {
        fs::create_dir_all(dir).await.map_err(|e| {
            format!("Impossible de créer le dossier '{}': {e}", dir.display())
        })?;
    }
    
    // Log de la summary
    emit_log(app, format!("[{}] Temp:     {}", job.id, paths.base.display()));
    emit_log(app, format!("[{}] Segments: {}", job.id, paths.segments_dir.display()));
    emit_log(app, format!("[{}] Sortie:   {}", job.id, paths.final_output.display()));
    emit_log(
        app,
        format!(
            "[{}] Frames: {} | chunk: {} | chunks estimés: {}",
            job.id, total_frames, chunk_size, estimated_chunks
        ),
    );
    if let Some(vt) = analysis.video_tracks.first() {
        emit_log(
            app,
            format!(
                "[{}] Vidéo > codec={} | {}x{} | {:.3} fps | {} frames | \
                 container={} | hdr={} | audio={} | subs={}",
                job.id,
                vt.codec.as_deref().unwrap_or("?"),
                vt.width.unwrap_or(analysis.width),
                vt.height.unwrap_or(analysis.height),
                vt.fps.unwrap_or(analysis.fps),
                vt.frame_count.unwrap_or(analysis.frame_count),
                analysis.container,
                analysis.has_hdr,
                analysis.audio_tracks.len(),
                analysis.subtitle_tracks.len(),
            ),
        );
    }

    job.status          = JobStatus::Processing;
    job.progress        = 3.0;
    job.extract_current = 0;
    job.extract_total   = 0;
    job.upscale_current = 0;
    job.upscale_total   = 0;
    emit_status(app, job);
    emit_log(app, format!("[{}] Analyse terminée", job.id));

    // Résolution du crop manual ou auto
    let crop_filter = job.settings.manual_crop
        .as_deref()
        .and_then(normalize_crop_filter);

    match &crop_filter {
        Some(f) => emit_log(
            app,
            format!(
                "[{}] Crop manuel: {f} | settings.manual_crop={}",
                job.id,
                job.settings.manual_crop.clone().unwrap_or_default()
            ),
        ),
        None if job.settings.auto_crop => {
            emit_log(app, format!("[{}] Auto-crop désactivé (ignoré)", job.id));
        }
        None => emit_log(app, format!("[{}] Crop désactivé", job.id)),
    }

    let deinterlace_filter = if job.settings.auto_deinterlace {
        let parity = detect_bwdif_parity(tools, &source_path).await;
        let filter = build_deinterlace_filter(&job.settings, &parity);
        emit_log(app, format!("[{}] Deinterlace filter: {filter}", job.id));
        Some(filter)
    } else {
        emit_log(app, format!("[{}] Deinterlace désactivé", job.id));
        None
    };

    // Boucle principale de pipeline
    for chunk_index in 0..estimated_chunks {
        wait_while_paused(app, job, &control_map).await?;

        let chunk_number = chunk_index + 1;
        let start_frame  = chunk_index * chunk_size;
        let end_frame    = (total_frames.saturating_sub(1)).min(start_frame + chunk_size - 1);
        let chunk_dir    = paths.chunk_dir(chunk_number);
        let raw_dir      = chunk_dir.join("raw");
        let upscaled_dir = chunk_dir.join("upscaled");

        emit_log(
            app,
            format!(
                "[{}] Chunk {}/{} | frames [{start_frame}..{end_frame}]",
                job.id, chunk_number, estimated_chunks
            ),
        );

        // Nettoyage des dossiers de travail précédents
        for dir in [&raw_dir, &upscaled_dir] {
            if fs::try_exists(dir).await.map_err(|e| e.to_string())? {
                fs::remove_dir_all(dir).await.ok();
            }
            fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
        }

        // Extraction des frames raw
        let raw_pattern = raw_dir.join("frame_%08d.png");
        extract_frames_chunk(
            app,
            job,
            &control_map,
            tools,
            &source_path,
            start_frame,
            end_frame,
            &raw_pattern,
            deinterlace_filter.as_deref(),
            crop_filter.as_deref(),
        )
        .await?;

        let extracted_count = count_png_files(&raw_dir).await?;
        job.extract_current = extracted_count;
        job.extract_total   = extracted_count;
        emit_status(app, job);

        if extracted_count == 0 {
            fs::remove_dir_all(&chunk_dir).await.ok();
            if chunk_videos.is_empty() {
                return Err("Aucune frame extraite sur le premier chunk".to_owned());
            }
            emit_log(
                app,
                format!("[{}] Chunk {chunk_number} vide — fin anticipée", job.id),
            );
            break;
        }

        // Upscaling des frames raw
        wait_while_paused(app, job, &control_map).await?;
        upscale_chunk(
            app,
            job,
            &control_map,
            tools,
            &raw_dir,
            &upscaled_dir,
            extracted_count,
            total_frames,
            &mut throughput,
        )
        .await?;

        // Encoding des frames upscaledées en segment vidéo
        wait_while_paused(app, job, &control_map).await?;
        let upscaled_pattern = upscaled_dir.join("frame_%08d.png");
        let segment_path     = paths.segment_path(chunk_number);
        encode_upscaled_frames(
            tools,
            &job.settings,
            &upscaled_pattern,
            analysis.fps,
            &segment_path,
            &job.id,
            control_map.clone(),
        )
        .await?;
        chunk_videos.push(segment_path);

        // Nettoyage des dossiers de travail actuel
        fs::remove_dir_all(&chunk_dir).await.ok();
        job.extract_current = 0;
        job.extract_total   = 0;
        job.upscale_current = 0;
        job.upscale_total   = 0;
        job.progress = 5.0 + (chunk_number as f32 / estimated_chunks as f32) * 80.0;
        emit_status(app, job);
        emit_log(
            app,
            format!(
                "[{}] Chunk {}/{} OK | FPS IA: {:.2}",
                job.id, chunk_number, estimated_chunks, job.fps
            ),
        );
    }

    // Validation des segments générés
    if chunk_videos.is_empty() {
        return Err("Aucun segment vidéo n'a été généré".to_owned());
    }

    // Concaténation des segments générés
    let concat_content = chunk_videos
        .iter()
        .map(|p| format!("file '{}'", p.to_string_lossy().replace('\\', "/").replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&paths.concat_list, concat_content)
        .await
        .map_err(|e| e.to_string())?;

    concat_segments(app, job, &control_map, tools, &paths.concat_list, &paths.encoded).await?;
    job.progress = 90.0;
    emit_status(app, job);
    emit_log(app, format!("[{}] Concat terminé", job.id));

    // Remuxage des segments générés avec les flux de source originaux
    remux_with_source_streams(
        tools,
        &job.settings,
        &source_path,
        &paths.encoded,
        &paths.final_output,
        &job.id,
        control_map.clone(),
    )
    .await?;

    job.output_path = paths.final_output.to_string_lossy().into_owned();
    job.progress    = 100.0;
    job.eta_seconds = Some(0);
    job.status      = JobStatus::Done;
    emit_status(app, job);
    emit_log(app, format!("[{}] Remux terminé: {}", job.id, job.output_path));

    fs::remove_dir_all(&paths.base).await.ok();
    Ok(())
}
