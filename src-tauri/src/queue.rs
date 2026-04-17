use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;
use uuid::Uuid;

use crate::app_paths::resolve_tool_paths;
use crate::models::{JobStatus, ProcessingSettings, QueueJob};
use crate::monitor::{emit_log, emit_status};
use crate::pipeline::{run_job_pipeline, JOB_CANCELED_ERR};
use crate::upscaler::validate_realcugan_settings;

fn normalize_manual_crop(raw: Option<String>) -> Option<String> {
    let value = raw?.trim().to_string();
    if value.is_empty() {
        return None;
    }
    if value.starts_with("crop=") {
        return Some(value);
    }
    let is_numeric_crop = value.split(':').count() == 4
        && value.split(':').all(|p| p.parse::<u32>().is_ok());
    if is_numeric_crop {
        return Some(format!("crop={value}"));
    }
    None
}

#[derive(Default)]
struct QueueState {
    jobs: Vec<QueueJob>,
    order: VecDeque<String>,
    running: bool,
}

#[derive(Clone, Default)]
pub struct QueueManager {
    state: Arc<Mutex<QueueState>>,
    control: Arc<Mutex<HashMap<String, JobStatus>>>,
}

impl QueueManager {
    pub async fn add_job(&self, input_path: String, settings: ProcessingSettings) -> Result<QueueJob, String> {
        if !PathBuf::from(&input_path).exists() {
            return Err("Le fichier source est introuvable".to_string());
        }
        validate_realcugan_settings(&settings)?;
        let output_dir_raw = settings.output_dir.trim();
        if output_dir_raw.is_empty() {
            return Err("Le dossier de sortie est vide".to_string());
        }
        let output_dir = PathBuf::from(output_dir_raw);
        std::fs::create_dir_all(&output_dir).map_err(|e| {
            format!(
                "Impossible de créer le dossier de sortie '{}': {e}",
                output_dir.display()
            )
        })?;
        let write_probe = output_dir.join(".animegui_write_probe");
        std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&write_probe)
            .map_err(|e| {
                format!(
                    "Le dossier de sortie '{}' n'est pas accessible en écriture: {e}",
                    output_dir.display()
                )
            })?;
        let _ = std::fs::remove_file(&write_probe);
        let id = Uuid::new_v4().to_string();
        let output_name = PathBuf::from(&input_path)
            .file_stem()
            .map(|v| v.to_string_lossy().to_string())
            .unwrap_or_else(|| "output".to_string());
        let output_path = output_dir
            .join(format!("{output_name}_upscaled.mkv"))
            .to_string_lossy()
            .to_string();

        let mut settings = settings;
        settings.manual_crop = normalize_manual_crop(settings.manual_crop.clone());

        let job = QueueJob {
            id: id.clone(),
            input_path,
            output_path,
            status: JobStatus::Waiting,
            progress: 0.0,
            fps: 0.0,
            extract_current: 0,
            extract_total: 0,
            upscale_current: 0,
            upscale_total: 0,
            eta_seconds: None,
            error: None,
            settings,
        };

        let mut state = self.state.lock().await;
        state.order.push_back(id);
        state.jobs.push(job.clone());
        drop(state);

        let mut control = self.control.lock().await;
        control.insert(job.id.clone(), JobStatus::Waiting);
        Ok(job)
    }

    pub async fn list_jobs(&self) -> Vec<QueueJob> {
        self.state.lock().await.jobs.clone()
    }

    pub async fn pause_job(&self, job_id: &str) {
        let mut state = self.state.lock().await;
        if let Some(job) = state.jobs.iter_mut().find(|job| job.id == job_id) {
            if matches!(job.status, JobStatus::Waiting | JobStatus::Processing) {
                job.status = JobStatus::Paused;
            }
        }
        drop(state);

        let mut control = self.control.lock().await;
        control.insert(job_id.to_string(), JobStatus::Paused);
    }

    pub async fn resume_job(&self, job_id: &str) {
        let mut state = self.state.lock().await;
        if let Some(job) = state.jobs.iter_mut().find(|job| job.id == job_id) {
            if job.status == JobStatus::Paused {
                job.status = JobStatus::Waiting;
            }
        }
        if !state.order.iter().any(|id| id == job_id) {
            state.order.push_back(job_id.to_string());
        }
        drop(state);

        let mut control = self.control.lock().await;
        control.insert(job_id.to_string(), JobStatus::Waiting);
    }

    pub async fn cancel_job(&self, job_id: &str) {
        let mut state = self.state.lock().await;
        if let Some(job) = state.jobs.iter_mut().find(|job| job.id == job_id) {
            if matches!(job.status, JobStatus::Waiting | JobStatus::Paused | JobStatus::Processing) {
                job.status = JobStatus::Canceled;
                state.order.retain(|id| id != job_id);
            }
        }
        drop(state);

        let mut control = self.control.lock().await;
        control.insert(job_id.to_string(), JobStatus::Canceled);
    }

    pub async fn retry_job(&self, job_id: &str) {
        let mut state = self.state.lock().await;
        if let Some(job) = state.jobs.iter_mut().find(|job| job.id == job_id) {
            if matches!(job.status, JobStatus::Error | JobStatus::Canceled) {
                job.status = JobStatus::Waiting;
                job.progress = 0.0;
                job.fps = 0.0;
                job.extract_current = 0;
                job.extract_total = 0;
                job.upscale_current = 0;
                job.upscale_total = 0;
                job.eta_seconds = None;
                job.error = None;
                if !state.order.iter().any(|id| id == job_id) {
                    state.order.push_back(job_id.to_string());
                }
            }
        }
        drop(state);

        let mut control = self.control.lock().await;
        control.insert(job_id.to_string(), JobStatus::Waiting);
    }

    pub async fn clear_done_jobs(&self) {
        let mut state = self.state.lock().await;
        state.jobs.retain(|job| job.status != JobStatus::Done);
        let valid_ids: std::collections::HashSet<String> =
            state.jobs.iter().map(|job| job.id.clone()).collect();
        state
            .order
            .retain(|id| valid_ids.contains(id));
        drop(state);

        let mut control = self.control.lock().await;
        control.retain(|id, _| valid_ids.contains(id));
    }

    pub async fn remove_job(&self, job_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let Some(index) = state.jobs.iter().position(|job| job.id == job_id) else {
            return Err("Job introuvable".to_string());
        };

        if state.jobs[index].status != JobStatus::Canceled {
            return Err("Seuls les jobs annules peuvent etre supprimes".to_string());
        }

        state.jobs.remove(index);
        state.order.retain(|id| id != job_id);
        drop(state);

        let mut control = self.control.lock().await;
        control.remove(job_id);
        Ok(())
    }

    pub async fn update_job_settings(
        &self,
        job_id: &str,
        settings: ProcessingSettings,
    ) -> Result<QueueJob, String> {
        validate_realcugan_settings(&settings)?;
        let mut state = self.state.lock().await;
        let Some(job) = state.jobs.iter_mut().find(|job| job.id == job_id) else {
            return Err("Job introuvable".to_string());
        };

        if matches!(job.status, JobStatus::Processing | JobStatus::Done) {
            return Err("Impossible de modifier un job en cours ou termine".to_string());
        }

        let mut settings = settings;
        settings.manual_crop = normalize_manual_crop(settings.manual_crop.clone());

        let output_name = PathBuf::from(&job.input_path)
            .file_stem()
            .map(|v| v.to_string_lossy().to_string())
            .unwrap_or_else(|| "output".to_string());
        let output_path = PathBuf::from(&settings.output_dir)
            .join(format!("{output_name}_upscaled.mkv"))
            .to_string_lossy()
            .to_string();

        job.settings = settings;
        job.output_path = output_path;
        Ok(job.clone())
    }

    pub async fn start_queue(&self, app: tauri::AppHandle) -> Result<(), String> {
        {
            let mut state = self.state.lock().await;
            if state.running {
                emit_log(&app, "Queue déjà en cours");
                return Ok(());
            }
            let waiting = state
                .jobs
                .iter()
                .filter(|job| job.status == JobStatus::Waiting)
                .count();
            emit_log(&app, format!("Démarrage queue: {waiting} job(s) en attente"));
            state.running = true;
        }

        let manager = self.clone();
        tokio::spawn(async move {
            let tools = match resolve_tool_paths() {
                Ok(value) => value,
                Err(error) => {
                    emit_log(&app, format!("Erreur chemins outils: {error}"));
                    manager.state.lock().await.running = false;
                    return;
                }
            };
            emit_log(
                &app,
                format!(
                    "Outils: ffmpeg={}, ffprobe={}, realcugan={}",
                    tools.ffmpeg_exe.display(),
                    tools.ffprobe_exe.display(),
                    tools.realcugan_exe.display()
                ),
            );

            loop {
                let next_job_id = {
                    let mut state = manager.state.lock().await;
                    let mut found = None;
                    while let Some(job_id) = state.order.pop_front() {
                        let is_waiting = state
                            .jobs
                            .iter()
                            .any(|job| job.id == job_id && job.status == JobStatus::Waiting);
                        if is_waiting {
                            found = Some(job_id);
                            break;
                        }
                    }
                    found
                };

                let Some(job_id) = next_job_id else {
                    manager.state.lock().await.running = false;
                    emit_log(&app, "Queue terminée");
                    break;
                };

                let mut job = {
                    let mut state = manager.state.lock().await;
                    let Some(existing) = state.jobs.iter_mut().find(|job| job.id == job_id) else {
                        continue;
                    };
                    existing.status = JobStatus::Processing;
                    emit_status(&app, existing);
                    existing.clone()
                };

                {
                    let mut control = manager.control.lock().await;
                    control.insert(job.id.clone(), JobStatus::Processing);
                }

                let result = run_job_pipeline(&app, &tools, &mut job, manager.control.clone()).await;

                let mut state = manager.state.lock().await;
                let mut final_status = job.status.clone();
                if let Some(existing) = state.jobs.iter_mut().find(|item| item.id == job.id) {
                    *existing = job.clone();
                    if let Err(error) = result {
                        if error == JOB_CANCELED_ERR {
                            existing.status = JobStatus::Canceled;
                            existing.error = None;
                            emit_log(&app, format!("[{}] Job annule", existing.id));
                        } else {
                            existing.status = JobStatus::Error;
                            existing.error = Some(error.clone());
                            emit_log(&app, format!("[{}] Erreur: {error}", existing.id));
                        }
                    }
                    final_status = existing.status.clone();
                    emit_status(&app, existing);
                }
                drop(state);

                let mut control = manager.control.lock().await;
                control.insert(job.id.clone(), final_status);
            }
        });

        Ok(())
    }

    pub async fn start_job_or_batch(&self, app: tauri::AppHandle, job_id: &str) -> Result<(), String> {
        {
            let mut state = self.state.lock().await;
            let Some(target) = state.jobs.iter().find(|job| job.id == job_id).cloned() else {
                return Err("Job introuvable".to_string());
            };
            let target_session = target.settings.preview_session_id.clone();
            let has_batch = if let Some(ref session_id) = target_session {
                state
                    .jobs
                    .iter()
                    .filter(|job| job.settings.preview_session_id.as_ref() == Some(session_id))
                    .count()
                    > 1
            } else {
                false
            };
            let target_ids: Vec<String> = state
                .jobs
                .iter()
                .filter(|job| {
                    if has_batch {
                        job.settings.preview_session_id == target_session
                    } else {
                        job.id == job_id
                    }
                })
                .map(|job| job.id.clone())
                .collect();

            for target_id in target_ids {
                let Some(job_index) = state.jobs.iter().position(|job| job.id == target_id) else {
                    continue;
                };
                let mut should_emit = false;
                if matches!(
                    state.jobs[job_index].status,
                    JobStatus::Waiting | JobStatus::Paused | JobStatus::Error | JobStatus::Canceled
                ) {
                    state.jobs[job_index].status = JobStatus::Waiting;
                    state.jobs[job_index].progress = 0.0;
                    state.jobs[job_index].fps = 0.0;
                    state.jobs[job_index].extract_current = 0;
                    state.jobs[job_index].extract_total = 0;
                    state.jobs[job_index].upscale_current = 0;
                    state.jobs[job_index].upscale_total = 0;
                    state.jobs[job_index].eta_seconds = None;
                    state.jobs[job_index].error = None;
                    if !state.order.iter().any(|id| id == &target_id) {
                        state.order.push_back(target_id.clone());
                    }
                    should_emit = true;
                }
                if should_emit {
                    let job_snapshot = state.jobs[job_index].clone();
                    emit_status(&app, &job_snapshot);
                }
            }
        }

        self.start_queue(app).await
    }
}
