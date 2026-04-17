import { Card } from "../ui/card";
import { Select } from "../ui/select";
import { Slider } from "../ui/slider";
import { Switch } from "../ui/switch";
import {
  availableDenoiseFor,
  availableScalesForModel,
  denoiseLabel,
  sanitizeProcessingSettings,
  type PresetName,
  type ProcessingSettings,
  type RuntimeCapabilities,
} from "../../types";
import { t } from "../../i18n";

interface SettingsPanelProps {
  preset: PresetName;
  settings: ProcessingSettings;
  runtimeCaps: RuntimeCapabilities | null;
  onPresetChange: (preset: PresetName) => void;
  onSettingsChange: (settings: ProcessingSettings) => void;
}

export function SettingsPanel({
  preset,
  settings,
  runtimeCaps,
  onPresetChange,
  onSettingsChange,
}: SettingsPanelProps) {
  function closestAllowed(value: number, allowed: number[]) {
    if (allowed.length === 0) {
      return value;
    }
    return allowed.reduce((closest, current) =>
      Math.abs(current - value) < Math.abs(closest - value) ? current : closest,
    );
  }

  const validScales = availableScalesForModel(settings.realcugan_model);
  const activeScale = validScales.includes(settings.upscale_factor)
    ? settings.upscale_factor
    : validScales[0];
  const denoiseOptions = availableDenoiseFor(
    settings.realcugan_model,
    activeScale,
  );
  const activeDenoise = denoiseOptions.includes(settings.denoise_level)
    ? settings.denoise_level
    : denoiseOptions[0];
  const modelTitle = settings.realcugan_model
    .replace("models-", "")
    .toUpperCase();
  const hasHardwareAccel = runtimeCaps?.hardware_accel_available ?? false;
  const hardwareEncoders = runtimeCaps?.available_hw_encoders ?? [];
  const gpuOptions = (() => {
    const detected = runtimeCaps?.detected_gpu_count ?? 0;
    const options = [
      { value: "cpu", label: "CPU" },
      { value: "auto", label: "Auto" },
    ];
    if (detected >= 1) {
      options.push({ value: "0", label: "GPU 0" });
    }
    if (detected >= 2) {
      options.push({ value: "1", label: "GPU 1" });
      options.push({ value: "0,1", label: "GPU 0 + 1" });
    }
    return options;
  })();

  const presets: PresetName[] = [
    "Anime HD",
    "Old DVD",
    "High Quality",
    "Custom",
  ];

  const presetLabel = (presetName: PresetName) => {
    if (presetName === "Anime HD") return t("settings.preset.animeHd");
    if (presetName === "Old DVD") return t("settings.preset.oldDvd");
    if (presetName === "High Quality") return t("settings.preset.highQuality");
    return t("settings.preset.custom");
  };
  return (
    <Card className="settings-card">
      <div className="panel-header">
        <h2>
          <span className="dot" />
          {t("settings.title")}
        </h2>
        <div className="presets">
          {presets.map((presetItem) => (
            <button
              key={presetItem}
              className={`preset-btn ${presetItem === preset ? "active" : ""}`}
              onClick={() => onPresetChange(presetItem)}
            >
              {presetLabel(presetItem)}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-grid">
        <label className="field slider-field">
          <span>{t("settings.upscaleFactor")}</span>
          <Slider
            min={2}
            max={4}
            step={1}
            value={activeScale}
            onValueChange={(value) =>
              onSettingsChange(
                sanitizeProcessingSettings({
                  ...settings,
                  upscale_factor: closestAllowed(value, validScales) as
                    | 2
                    | 3
                    | 4,
                }),
              )
            }
          />
          <div className="settings-pills">
            {validScales.map((scale) => (
              <span
                key={`scale-${scale}`}
                className={`settings-pill ${scale === activeScale ? "active" : ""}`}
              >
                x{scale}
              </span>
            ))}
          </div>
        </label>
        <label className="field slider-field">
          <span>{t("settings.denoise")}</span>
          <Slider
            min={-1}
            max={3}
            step={1}
            value={activeDenoise}
            onValueChange={(value) =>
              onSettingsChange(
                sanitizeProcessingSettings({
                  ...settings,
                  denoise_level: closestAllowed(value, denoiseOptions) as
                    | -1
                    | 0
                    | 1
                    | 2
                    | 3,
                }),
              )
            }
          />
          <div className="settings-pills">
            {denoiseOptions.map((level) => (
              <span
                key={`denoise-${level}`}
                className={`settings-pill ${level === activeDenoise ? "active" : ""}`}
              >
                {denoiseLabel(level)}
              </span>
            ))}
          </div>
        </label>
        <label className="field select-field">
          <span>{t("settings.codec")}</span>
          <Select
            value={settings.video_codec}
            options={[
              { value: "h264", label: "H264" },
              { value: "h265", label: "H265" },
              { value: "av1", label: "AV1" },
            ]}
            onValueChange={(value) =>
              onSettingsChange({
                ...settings,
                video_codec: value as "h264" | "h265" | "av1",
              })
            }
          />
        </label>
        <label className="field select-field">
          <span>Résolution finale</span>
          <Select
            value={settings.final_resolution}
            options={[
              { value: "source", label: t("settings.sourceUpscale") },
              { value: "720p", label: "720p (1280x720)" },
              { value: "1080p", label: "1080p (1920x1080)" },
              { value: "4k", label: "4K (3840x2160)" },
            ]}
            onValueChange={(value) =>
              onSettingsChange({
                ...settings,
                final_resolution: value as "source" | "720p" | "1080p" | "4k",
              })
            }
          />
        </label>
        <label className="field select-field">
          <span>{t("settings.chunkSize")}</span>
          <Select
            value={String(settings.chunk_size)}
            options={[
              { value: "300", label: "300" },
              { value: "500", label: "500" },
              { value: "1000", label: "1000" },
              { value: "2000", label: "2000" },
            ]}
            onValueChange={(value) =>
              onSettingsChange({
                ...settings,
                chunk_size: Number(value) as 300 | 500 | 1000 | 2000,
              })
            }
          />
        </label>
        <label className="field select-field model-field">
          <div className="field-label-row">
            <span>{t("settings.model")}</span>
            <div className="model-meta-wrap">
              <div className="model-inline-meta">
                <span className="settings-pill active">{modelTitle}</span>
                <span className="material-icons-round model-inline-meta-icon">
                  info
                </span>
              </div>
              <div className="model-tooltip">
                <div className="hw-accel-tooltip-title">
                  {t("settings.model")}
                </div>
                <div className="settings-compat-row">
                  <span className="settings-compat-text">
                    GPU: {settings.realcugan_gpu}
                  </span>
                </div>
                <div className="settings-compat-row">
                  <span className="settings-compat-text">
                    {t("settings.scales")}:{" "}
                    {validScales.map((scale) => `x${scale}`).join(" / ")}
                  </span>
                </div>
                <div className="settings-compat-row">
                  <span className="settings-compat-text">
                    Denoise:{" "}
                    {denoiseOptions
                      .map((level) => denoiseLabel(level))
                      .join(" / ")}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <Select
            value={settings.realcugan_model}
            options={[
              { value: "models-se", label: "models-se" },
              { value: "models-pro", label: "models-pro" },
              { value: "models-nose", label: "models-nose" },
            ]}
            onValueChange={(value) =>
              onSettingsChange(
                sanitizeProcessingSettings({
                  ...settings,
                  realcugan_model: value as
                    | "models-se"
                    | "models-pro"
                    | "models-nose",
                }),
              )
            }
          />
        </label>
        <label className="field select-field">
          <span>{t("settings.qualityMode")}</span>
          <Select
            value={settings.quality_mode}
            options={[
              { value: "crf", label: "CRF" },
              { value: "bitrate", label: "Bitrate" },
            ]}
            onValueChange={(value) =>
              onSettingsChange({
                ...settings,
                quality_mode: value as "crf" | "bitrate",
              })
            }
          />
        </label>
        <label className="field select-field">
          <span>{t("settings.gpuTarget")}</span>
          <Select
            value={settings.realcugan_gpu}
            options={gpuOptions}
            onValueChange={(value) =>
              onSettingsChange(
                sanitizeProcessingSettings({
                  ...settings,
                  realcugan_gpu: value as "auto" | "cpu" | "0" | "1" | "0,1",
                }),
              )
            }
          />
        </label>
      </div>
      <div className="settings-extra">
        <label className="field-inline">
          <span>{t("settings.tta")}</span>
          <Switch
            checked={settings.tta_mode}
            onCheckedChange={(value) =>
              onSettingsChange({
                ...settings,
                tta_mode: value,
              })
            }
          />
        </label>
        <label className="field-inline">
          <span>{t("settings.copyAudio")}</span>
          <Switch
            checked={settings.copy_audio}
            onCheckedChange={(value) =>
              onSettingsChange({
                ...settings,
                copy_audio: value,
              })
            }
          />
        </label>
        <label className="field-inline">
          <span>{t("settings.copySubs")}</span>
          <Switch
            checked={settings.copy_subs}
            onCheckedChange={(value) =>
              onSettingsChange({
                ...settings,
                copy_subs: value,
              })
            }
          />
        </label>
        <label className="field-inline field-inline-tooltip">
          <span>{t("settings.hardwareAccel")}</span>
          <div className="hw-accel-wrap">
            <Switch
              checked={settings.hardware_accel}
              onCheckedChange={(value) =>
                onSettingsChange({
                  ...settings,
                  hardware_accel: value,
                })
              }
            />
            <div className="hw-accel-tooltip">
              <div className="hw-accel-tooltip-title">
                {hasHardwareAccel
                  ? t("settings.hwDetected")
                  : t("settings.hwUnavailable")}
              </div>
              {hasHardwareAccel ? (
                <div className="hw-accel-encoders">
                  {hardwareEncoders.map((encoder) => (
                    <span key={encoder} className="hw-accel-chip">
                      {encoder}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="hw-accel-tooltip-text">
                  {t("settings.hwNone")}
                </div>
              )}
            </div>
          </div>
        </label>
        <label className="field-inline">
          <span>{t("settings.autoDeinterlace")}</span>
          <Switch
            checked={settings.auto_deinterlace}
            onCheckedChange={(value) =>
              onSettingsChange({
                ...settings,
                auto_deinterlace: value,
              })
            }
          />
        </label>
        <label className="field-inline">
          <span>{t("settings.dvdStable")}</span>
          <Switch
            checked={settings.deinterlace_mode === "yadif"}
            onCheckedChange={(value) =>
              onSettingsChange({
                ...settings,
                deinterlace_mode: value ? "yadif" : "bwdif",
              })
            }
          />
        </label>
      </div>
    </Card>
  );
}
