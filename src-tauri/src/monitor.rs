use tauri::{AppHandle, Emitter};

use crate::models::QueueJob;

pub fn emit_log(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit("job-log", message.into());
}

pub fn emit_status(app: &AppHandle, job: &QueueJob) {
    let _ = app.emit("job-status", job.clone());
}
