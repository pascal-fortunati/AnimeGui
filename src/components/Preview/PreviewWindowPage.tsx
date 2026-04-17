import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  addJob,
  analyzeFile,
  previewFrame,
  updateJobSettings,
} from "../../api";
import {
  sanitizeProcessingSettings,
  type ProcessingSettings,
  type VideoAnalysis,
} from "../../types";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { Slider } from "../ui/slider";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { t } from "../../i18n";

// Types
type Edge = "left" | "right" | "top" | "bottom";

function edgeLabel(edge: Edge) {
  return t(`preview.edge.${edge}`);
}

interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PreviewContext {
  inputPath: string;
  inputPaths?: string[];
  settings: ProcessingSettings;
  previewId?: string;
  jobId?: string;
  srtPath?: string;
  audioSelection?: string;
  subtitleSelection?: string;
  previewWindowLabel?: string;
}

// Presset de Crop
interface CropPreset {
  label: string;
  description: string;
  apply: (w: number, h: number) => Partial<Edges>;
}

const CROP_PRESETS: CropPreset[] = [
  {
    label: t("preview.presetReset"),
    description: t("preview.presetResetDesc"),
    apply: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
  },
  {
    label: t("preview.presetOverscan"),
    description: t("preview.presetOverscanDesc"),
    apply: (w, h) => ({
      left: Math.round((w * 0.025) / 2) * 2,
      right: Math.round((w * 0.025) / 2) * 2,
      top: Math.round((h * 0.025) / 2) * 2,
      bottom: Math.round((h * 0.025) / 2) * 2,
    }),
  },
  {
    label: t("preview.presetLetterbox"),
    description: t("preview.presetLetterboxDesc"),
    apply: (w, h) => {
      const targetH = Math.round((w * 9) / 16 / 2) * 2;
      const strip = Math.max(0, Math.round((h - targetH) / 4) * 2);
      return { top: strip, bottom: strip };
    },
  },
  {
    label: t("preview.presetPillarbox"),
    description: t("preview.presetPillarboxDesc"),
    apply: (w, h) => {
      const targetW = Math.round((h * 4) / 3 / 2) * 2;
      const strip = Math.max(0, Math.round((w - targetW) / 4) * 2);
      return { left: strip, right: strip };
    },
  },
  {
    label: t("preview.presetCinema"),
    description: t("preview.presetCinemaDesc"),
    apply: (w, h) => {
      const targetH = Math.round(w / 2.35 / 2) * 2;
      const strip = Math.max(0, Math.round((h - targetH) / 4) * 2);
      return { top: strip, bottom: strip };
    },
  },
];

// Helper de sous-titres
function subtitleCanConvertToSrt(codec?: string): boolean {
  if (!codec) return false;
  return ["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"].includes(
    codec,
  );
}

function subtitleIsImageBased(codec?: string): boolean {
  if (!codec) return false;
  return ["dvd_subtitle", "hdmv_pgs_subtitle", "xsub"].includes(codec);
}

// Parsing de Crop
function parseCrop(
  raw?: string,
): { width: number; height: number; x: number; y: number } | null {
  if (!raw) return null;
  const normalized = raw.startsWith("crop=") ? raw.slice(5) : raw;
  const parts = normalized.split(":").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return null;
  const [w, h, x, y] = parts;
  return {
    width: Math.max(1, w),
    height: Math.max(1, h),
    x: Math.max(0, x),
    y: Math.max(0, y),
  };
}

function cropToString(
  sourceWidth: number,
  sourceHeight: number,
  edges: Edges,
): string {
  const width = Math.max(16, sourceWidth - edges.left - edges.right);
  const height = Math.max(16, sourceHeight - edges.top - edges.bottom);
  return `${width}:${height}:${Math.max(0, edges.left)}:${Math.max(0, edges.top)}`;
}

// Fonction de snap
function snapToEven(v: number): number {
  return Math.round(v / 2) * 2;
}

// Fonction de clamp
function clampEven(value: number, min: number, max: number): number {
  return snapToEven(Math.max(min, Math.min(max, value)));
}

// Clé de session
function sessionKey(ctx: PreviewContext | null): string | null {
  if (!ctx) return null;
  const id = ctx.previewId ?? ctx.settings.preview_session_id ?? "default";
  return `animegui-preview-state-${id}`;
}

// Clé de tracks
function tracksKey(ctx: PreviewContext | null): string | null {
  if (!ctx) return null;
  const id = ctx.previewId ?? ctx.settings.preview_session_id ?? "default";
  return `animegui-preview-tracks-${id}`;
}

// Composant de preview
export function PreviewWindowPage() {
  const appWindow = getCurrentWindow();
  const imageWrapRef = useRef<HTMLDivElement | null>(null);
  const origImgRef = useRef<HTMLImageElement | null>(null);

  // Contexte de preview
  const [context, setContext] = useState<PreviewContext | null>(null);
  const [analysis, setAnalysis] = useState<VideoAnalysis | null>(null);
  const [isAnalyzingTracks, setIsAnalyzingTracks] = useState(false);

  // Sélection de tracks
  const [audioSelection, setAudioSelection] = useState("all");
  const [subtitleSelection, setSubtitleSelection] = useState("all");
  const [subtitleOutputFormat, setSubtitleOutputFormat] = useState<
    "copy" | "srt"
  >("copy");

  // Frame actuel
  const [frameIndex, setFrameIndex] = useState(0);
  const [isFrameInitialized, setIsFrameInitialized] = useState(false);
  const [frameTotal, setFrameTotal] = useState(1);
  const [sourceWidth, setSourceWidth] = useState(1);
  const [sourceHeight, setSourceHeight] = useState(1);

  // Crop
  const [manualCropEnabled] = useState(true);
  const [detectedCrop, setDetectedCrop] = useState<string | null>(null);
  const [appliedCrop, setAppliedCrop] = useState<string | null>(null);
  const [edges, setEdges] = useState<Edges>({
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  });
  const [draggingEdge, setDraggingEdge] = useState<Edge | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null); // keyboard target
  const [hasUserAdjustedCrop, setHasUserAdjustedCrop] = useState(false);
  const [previewCropApplied, setPreviewCropApplied] = useState<
    string | undefined
  >(undefined);
  const [imageDisplayRect, setImageDisplayRect] = useState({
    offsetX: 0,
    offsetY: 0,
    width: 1,
    height: 1,
  });

  // Images
  const [originalDataUrl, setOriginalDataUrl] = useState<string | null>(null);
  const [upscaledDataUrl, setUpscaledDataUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [hasRendered, setHasRendered] = useState(false);

  // Limite de Crop
  const MIN_CROP_SIZE = 16;

  const maxEdge = useCallback(
    (edge: Edge): number => {
      if (edge === "left")
        return Math.max(0, sourceWidth - edges.right - MIN_CROP_SIZE);
      if (edge === "right")
        return Math.max(0, sourceWidth - edges.left - MIN_CROP_SIZE);
      if (edge === "top")
        return Math.max(0, sourceHeight - edges.bottom - MIN_CROP_SIZE);
      if (edge === "bottom")
        return Math.max(0, sourceHeight - edges.top - MIN_CROP_SIZE);
      return 0;
    },
    [edges, sourceWidth, sourceHeight],
  );

  // Fonction de setEdgeValue
  // Met à jour la valeur d'un edge en tenant compte les limites de Crop
  // et les valeurs snapées
  const setEdgeValue = useCallback(
    (edge: Edge, raw: number) => {
      setEdges((prev) => {
        const max = (() => {
          if (edge === "left")
            return Math.max(0, sourceWidth - prev.right - MIN_CROP_SIZE);
          if (edge === "right")
            return Math.max(0, sourceWidth - prev.left - MIN_CROP_SIZE);
          if (edge === "top")
            return Math.max(0, sourceHeight - prev.bottom - MIN_CROP_SIZE);
          if (edge === "bottom")
            return Math.max(0, sourceHeight - prev.top - MIN_CROP_SIZE);
          return 0;
        })();
        return { ...prev, [edge]: clampEven(raw, 0, max) };
      });
      setHasUserAdjustedCrop(true);
    },
    [sourceWidth, sourceHeight],
  );

  const nudgeEdge = useCallback(
    (edge: Edge, delta: number) => {
      setEdges((prev) => {
        const current = prev[edge];
        const max = (() => {
          if (edge === "left")
            return Math.max(0, sourceWidth - prev.right - MIN_CROP_SIZE);
          if (edge === "right")
            return Math.max(0, sourceWidth - prev.left - MIN_CROP_SIZE);
          if (edge === "top")
            return Math.max(0, sourceHeight - prev.bottom - MIN_CROP_SIZE);
          if (edge === "bottom")
            return Math.max(0, sourceHeight - prev.top - MIN_CROP_SIZE);
          return 0;
        })();
        return { ...prev, [edge]: clampEven(current + delta, 0, max) };
      });
      setHasUserAdjustedCrop(true);
    },
    [sourceWidth, sourceHeight],
  );

  // Chargement du contexte de preview depuis localStorage
  useEffect(() => {
    const loadContextFromStorage = () => {
      const raw = localStorage.getItem("animegui-preview-context");
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as PreviewContext;
        const settings = sanitizeProcessingSettings(parsed.settings);
        const ctx = { ...parsed, settings };
        setContext(ctx);

        // Chargement des tracks
        // Si les tracks sont stockés dans localStorage, les charger
        const tk = tracksKey(ctx);
        if (tk) {
          try {
            const rawTracks = localStorage.getItem(tk);
            if (rawTracks) {
              const cached = JSON.parse(rawTracks) as VideoAnalysis;
              if (cached.frame_count > 0) setAnalysis(cached);
            }
          } catch {
            localStorage.removeItem(tk!);
          }
        }

        // Récupère l'index de frame actuel
        // Si l'index de frame actuel est stocké dans localStorage, le charger
        // Sinon, utiliser la valeur par défaut
        const sk = sessionKey(ctx);
        let restored = false;
        if (sk) {
          try {
            const saved = localStorage.getItem(sk);
            if (saved) {
              const state = JSON.parse(saved) as { frameIndex?: number };
              if (typeof state.frameIndex === "number" && state.frameIndex >= 0) {
                setFrameIndex(Math.floor(state.frameIndex));
                restored = true;
              }
            }
          } catch {
            localStorage.removeItem(sk!);
          }
        }
        if (!restored && typeof settings.preview_last_frame_index === "number") {
          setFrameIndex(
            Math.max(0, Math.floor(settings.preview_last_frame_index)),
          );
          restored = true;
        }
        if (restored) setIsFrameInitialized(true);

        // Chargement des options de copie
        // Si on revient de DVD, restaurer les sélections sauvegardées
        setAudioSelection(
          ctx.audioSelection ??
          (settings.copy_audio
            ? settings.selected_audio_stream_index !== undefined
              ? String(settings.selected_audio_stream_index)
              : "all"
            : "none"),
        );
        // Chargement des options de copie des sous-titres
        // Si on a un SRT exporté du DVD, désactiver la copie des sous-titres
        const finalSubtitleSelection = ctx.srtPath
          ? "external_srt"
          : ctx.subtitleSelection ??
          (settings.copy_subs
            ? settings.selected_subtitle_stream_index !== undefined
              ? String(settings.selected_subtitle_stream_index)
              : "all"
            : "none");
        setSubtitleSelection(finalSubtitleSelection);

        setSubtitleOutputFormat(settings.subtitle_output_format);

        // Chargement des options de crop
        setPreviewCropApplied(settings.manual_crop);
        if (settings.manual_crop) {
          const parsed = parseCrop(settings.manual_crop);
          if (parsed) {
            const w = sourceWidth || 1920; // Si la largeur source n'est pas connue, utiliser 1920
            const h = sourceHeight || 1080; // Si la hauteur source n'est pas connue, utiliser 1080
            setEdges({
              left: parsed.x,
              top: parsed.y,
              right: Math.max(0, w - (parsed.x + parsed.width)),
              bottom: Math.max(0, h - (parsed.y + parsed.height)),
            });
          }
        }
      } catch {
        setContext(null);
      }
    };

    loadContextFromStorage();

    // Recharger le contexte quand la fenêtre redevient visible
    // (après retour du DVD window)
    const appWindow = getCurrentWindow();
    const unlistenFocus = appWindow.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        loadContextFromStorage();
      }
    });

    return () => {
      void unlistenFocus.then((f) => f());
    };
  }, []);

  // Analyse de la vidéo
  useEffect(() => {
    if (!context?.inputPath || analysis) return;
    let cancelled = false;
    void (async () => {
      setIsAnalyzingTracks(true);
      try {
        const result = await analyzeFile(context.inputPath);
        if (cancelled) return;
        setAnalysis(result);
        const tk = tracksKey(context);
        if (tk) localStorage.setItem(tk, JSON.stringify(result));
        if (!isFrameInitialized) {
          setFrameIndex(Math.floor(Math.max(1, result.frame_count || 1) / 2));
          setIsFrameInitialized(true);
        }
      } catch {
        if (!cancelled && !isFrameInitialized) {
          setFrameIndex(0);
          setIsFrameInitialized(true);
        }
      } finally {
        if (!cancelled) setIsAnalyzingTracks(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [context, analysis, isFrameInitialized]);

  useEffect(() => {
    if (!analysis || isFrameInitialized) return;
    setFrameIndex(Math.floor(Math.max(1, analysis.frame_count || 1) / 2));
    setIsFrameInitialized(true);
  }, [analysis, isFrameInitialized]);

  // Mise à jour de la rect d'affichage de l'image
  useEffect(() => {
    const wrap = imageWrapRef.current;
    const img = origImgRef.current;
    if (!wrap || !img) return;

    const update = () => {
      const wR = wrap.getBoundingClientRect();
      const iR = img.getBoundingClientRect();
      setImageDisplayRect({
        offsetX: Math.max(0, iR.left - wR.left),
        offsetY: Math.max(0, iR.top - wR.top),
        width: Math.max(1, iR.width),
        height: Math.max(1, iR.height),
      });
    };

    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    ro.observe(img);
    img.addEventListener("load", update);
    update();
    return () => {
      ro.disconnect();
      img.removeEventListener("load", update);
    };
  }, [originalDataUrl]);

  // Chargement de l'image de prévisualisation
  useEffect(() => {
    if (!context?.inputPath || !isFrameInitialized) return;
    let cancelled = false;
    const delay = hasRendered ? 140 : 0;

    const timer = setTimeout(async () => {
      setIsLoading(true);
      try {
        const result = await previewFrame(
          context.inputPath,
          {
            ...context.settings,
            auto_crop: false,
            manual_crop: previewCropApplied,
          },
          frameIndex,
          context.previewId ?? context.settings.preview_session_id,
        );
        if (cancelled) return;
        setFrameTotal(Math.max(1, result.frame_total));
        setFrameIndex(result.frame_index);
        setSourceWidth(Math.max(1, result.source_width));
        setSourceHeight(Math.max(1, result.source_height));
        setDetectedCrop(result.detected_crop);
        setAppliedCrop(result.applied_crop);
        setOriginalDataUrl(
          `data:image/png;base64,${result.original_png_base64}`,
        );
        setUpscaledDataUrl(
          `data:image/png;base64,${result.upscaled_png_base64}`,
        );
        setHasRendered(true);
      } catch {
        if (!cancelled) {
          setOriginalDataUrl(null);
          setUpscaledDataUrl(null);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [context, frameIndex, previewCropApplied, isFrameInitialized]);

  // Sauvegarde de l'index de frame
  useEffect(() => {
    const sk = sessionKey(context);
    if (!sk || !isFrameInitialized) return;
    localStorage.setItem(sk, JSON.stringify({ frameIndex }));
  }, [context, frameIndex, isFrameInitialized]);

  // Mise à jour des lignes de crop
  useEffect(() => {
    if (!manualCropEnabled) return;

    const onMove = (ev: MouseEvent) => {
      if (!draggingEdge || !imageWrapRef.current) return;
      const rect = imageWrapRef.current.getBoundingClientRect();
      const xInImg = Math.max(
        0,
        Math.min(
          imageDisplayRect.width,
          ev.clientX - rect.left - imageDisplayRect.offsetX,
        ),
      );
      const yInImg = Math.max(
        0,
        Math.min(
          imageDisplayRect.height,
          ev.clientY - rect.top - imageDisplayRect.offsetY,
        ),
      );
      const pxX = Math.round((xInImg / imageDisplayRect.width) * sourceWidth);
      const pxY = Math.round((yInImg / imageDisplayRect.height) * sourceHeight);

      setEdges((prev) => {
        const next = { ...prev };
        if (draggingEdge === "left")
          next.left = clampEven(
            pxX,
            0,
            sourceWidth - prev.right - MIN_CROP_SIZE,
          );
        if (draggingEdge === "right")
          next.right = clampEven(
            sourceWidth - pxX,
            0,
            sourceWidth - prev.left - MIN_CROP_SIZE,
          );
        if (draggingEdge === "top")
          next.top = clampEven(
            pxY,
            0,
            sourceHeight - prev.bottom - MIN_CROP_SIZE,
          );
        if (draggingEdge === "bottom")
          next.bottom = clampEven(
            sourceHeight - pxY,
            0,
            sourceHeight - prev.top - MIN_CROP_SIZE,
          );
        return next;
      });
      setHasUserAdjustedCrop(true);
    };

    const onUp = () => setDraggingEdge(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [
    draggingEdge,
    sourceWidth,
    sourceHeight,
    manualCropEnabled,
    imageDisplayRect,
  ]);

  // Mise à jour des lignes de crop en utilisant les touches clavier
  useEffect(() => {
    if (!manualCropEnabled || !selectedEdge) return;

    const onKey = (ev: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key))
        return;
      ev.preventDefault();
      const step = ev.shiftKey ? 10 : ev.altKey ? 1 : 2; // Shift=10px, Alt=1px, default=2px (even)

      const delta = (() => {
        if (selectedEdge === "left") {
          if (ev.key === "ArrowRight") return step;
          if (ev.key === "ArrowLeft") return -step;
        }
        if (selectedEdge === "right") {
          if (ev.key === "ArrowLeft") return step;
          if (ev.key === "ArrowRight") return -step;
        }
        if (selectedEdge === "top") {
          if (ev.key === "ArrowDown") return step;
          if (ev.key === "ArrowUp") return -step;
        }
        if (selectedEdge === "bottom") {
          if (ev.key === "ArrowUp") return step;
          if (ev.key === "ArrowDown") return -step;
        }
        return 0;
      })();

      if (delta !== 0) nudgeEdge(selectedEdge, delta);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [manualCropEnabled, selectedEdge, nudgeEdge]);

  // Mise à jour des lignes de crop en utilisant les valeurs détectées ou appliquées
  useEffect(() => {
    if (!manualCropEnabled || hasUserAdjustedCrop) return;
    const seed = appliedCrop ?? detectedCrop;
    if (!seed || sourceWidth <= 0 || sourceHeight <= 0) return;
    const parsed = parseCrop(seed);
    if (parsed) {
      setEdges({
        left: parsed.x,
        top: parsed.y,
        right: Math.max(0, sourceWidth - (parsed.x + parsed.width)),
        bottom: Math.max(0, sourceHeight - (parsed.y + parsed.height)),
      });
    }
  }, [
    manualCropEnabled,
    hasUserAdjustedCrop,
    detectedCrop,
    appliedCrop,
    sourceWidth,
    sourceHeight,
  ]);

  // Calcul des valeurs de crop
  const manualCropString = useMemo(
    () => cropToString(sourceWidth, sourceHeight, edges),
    [sourceWidth, sourceHeight, edges],
  );

  const cropResult = useMemo(() => {
    const w = Math.max(16, sourceWidth - edges.left - edges.right);
    const h = Math.max(16, sourceHeight - edges.top - edges.bottom);
    return { width: w, height: h };
  }, [sourceWidth, sourceHeight, edges]);

  const frameLabel = `${Math.min(frameIndex + 1, frameTotal)}/${frameTotal}`;
  const sourceName =
    context?.inputPath.split("\\").pop() ?? context?.inputPath ?? "-";
  const batchTargets = context?.inputPaths?.length
    ? context.inputPaths
    : context?.inputPath
      ? [context.inputPath]
      : [];
  const parsedApplied = parseCrop(appliedCrop ?? undefined);
  const upscaleFactor = context?.settings.upscale_factor ?? 2;
  const upscaledWidth = (parsedApplied?.width ?? sourceWidth) * upscaleFactor;
  const upscaledHeight =
    (parsedApplied?.height ?? sourceHeight) * upscaleFactor;
  const showLoading = isLoading || (!isFrameInitialized && isAnalyzingTracks);

  const selectedSubtitleCodec = useMemo(() => {
    if (
      !analysis ||
      subtitleSelection === "all" ||
      subtitleSelection === "none"
    )
      return undefined;
    return analysis.subtitle_tracks.find(
      (t) => String(t.stream_index) === subtitleSelection,
    )?.codec;
  }, [analysis, subtitleSelection]);

  const dvdSubtitleSelected = useMemo(() => {
    if (!analysis || subtitleSelection === "none") {
      return false;
    }
    if (subtitleSelection === "all") {
      return analysis.subtitle_tracks.some(
        (track) => track.codec?.toLowerCase() === "dvd_subtitle",
      );
    }
    return selectedSubtitleCodec?.toLowerCase() === "dvd_subtitle";
  }, [analysis, subtitleSelection, selectedSubtitleCodec]);

  const shouldOpenDvdSubtitleWindow = useMemo(() => {
    return dvdSubtitleSelected;
  }, [dvdSubtitleSelected]);

  const srtSupported = subtitleCanConvertToSrt(selectedSubtitleCodec);
  const imageSubSelected = subtitleIsImageBased(selectedSubtitleCodec);
  const imageSubBlocked = imageSubSelected && !dvdSubtitleSelected;

  const subtitleOutputOptions = dvdSubtitleSelected
    ? [
      { value: "copy", label: t("preview.subCopy") },
      { value: "srt", label: t("preview.subToSrt") },
    ]
    : srtSupported
      ? [
        { value: "copy", label: t("preview.subCopy") },
        { value: "srt", label: t("preview.subToSrt") },
      ]
      : [{ value: "copy", label: t("preview.subCopy") }];

  const audioOptions = useMemo(() => {
    if (!analysis) return [{ value: "all", label: t("preview.allAudio") }];
    return [
      { value: "none", label: t("preview.noAudio") },
      {
        value: "all",
        label: t("preview.allAudioCount", {
          count: analysis.audio_tracks.length,
        }),
      },
      ...analysis.audio_tracks.map((t) => ({
        value: String(t.stream_index),
        label: `#${t.stream_index} ${t.language ?? "und"} ${t.codec ?? "audio"}${t.title ? ` - ${t.title}` : ""}${t.is_default ? " (default)" : ""}`,
      })),
    ];
  }, [analysis]);

  const subtitleOptions = useMemo(() => {
    // Si on a un SRT externe (du DVD OCR), l'afficher en premier
    if (context?.srtPath) {
      const srtFilename = context.srtPath.split("\\").pop() || context.srtPath;
      return [
        { value: "external_srt", label: `✓ SRT: ${srtFilename}` },
      ];
    }

    if (!analysis) return [{ value: "all", label: t("preview.allSubs") }];
    return [
      { value: "none", label: t("preview.noSubs") },
      {
        value: "all",
        label: t("preview.allSubsCount", {
          count: analysis.subtitle_tracks.length,
        }),
      },
      ...analysis.subtitle_tracks.map((t) => ({
        value: String(t.stream_index),
        label: `#${t.stream_index} ${t.language ?? "und"} ${t.codec ?? "sub"}${t.title ? ` - ${t.title}` : ""}${t.is_default ? " (default)" : ""}`,
      })),
    ];
  }, [analysis, context?.srtPath]);

  // Calcul des positions des lignes de crop
  const leftPx =
    imageDisplayRect.offsetX +
    (edges.left / sourceWidth) * imageDisplayRect.width;
  const rightPx =
    imageDisplayRect.offsetX +
    ((sourceWidth - edges.right) / sourceWidth) * imageDisplayRect.width;
  const topPx =
    imageDisplayRect.offsetY +
    (edges.top / sourceHeight) * imageDisplayRect.height;
  const bottomPx =
    imageDisplayRect.offsetY +
    ((sourceHeight - edges.bottom) / sourceHeight) * imageDisplayRect.height;

  // Gestionnaire de confirmation
  const handleConfirm = async () => {
    if (!context?.inputPath) return;
    setIsConfirming(true);
    try {
      const keepAudio = audioSelection !== "none";
      const keepSubs = subtitleSelection !== "none";
      const singleSub =
        subtitleSelection !== "all" && subtitleSelection !== "none";

      console.log("DEBUG handleConfirm:", {
        keepAudio,
        keepSubs,
        subtitleSelection,
        shouldOpenDvdSubtitleWindow,
        dvdSubtitleSelected,
      });

      const rawCrop = (
        appliedCrop ??
        previewCropApplied ??
        manualCropString
      ).trim();
      const cropForSave = rawCrop
        ? rawCrop.startsWith("crop=")
          ? rawCrop
          : `crop=${rawCrop}`
        : undefined;

      // Si on revient de DVD avec un SRT exporté, utiliser ce SRT au lieu de copier les sous-titres
      const hasSrtFromDvd = context.srtPath;
      const finalSettings: ProcessingSettings & { external_srt_path?: string } = {
        ...context.settings,
        auto_crop: false,
        manual_crop: cropForSave,
        preview_last_frame_index: frameIndex,
        copy_audio: keepAudio,
        copy_subs: hasSrtFromDvd ? false : keepSubs,
        selected_audio_stream_index:
          keepAudio && audioSelection !== "all"
            ? Number(audioSelection)
            : undefined,
        selected_subtitle_stream_index:
          keepSubs && singleSub && !hasSrtFromDvd ? Number(subtitleSelection) : undefined,
        subtitle_output_format:
          keepSubs && singleSub && !hasSrtFromDvd ? subtitleOutputFormat : "copy",
        external_srt_path: hasSrtFromDvd ? context.srtPath : undefined,
      };

      if (keepSubs && shouldOpenDvdSubtitleWindow) {
        const previewContext = {
          inputPaths: batchTargets,
          audioSelection,
          subtitleSelection,
          settings: finalSettings,
          previewWindowLabel: appWindow.label,
        };
        localStorage.setItem(
          "animegui-dvdsubs-context",
          JSON.stringify(previewContext),
        );

        try {
          // Masquer Preview d'abord
          await appWindow.hide();

          // Attendre que Preview soit cachée
          await new Promise(resolve => setTimeout(resolve, 300));

          // PUIS créer la fenêtre DVD
          new WebviewWindow(`dvdsubs-${Date.now()}`, {
            title: t("dvd.title"),
            url: "index.html?dvdsubs=1",
            width: 1300,
            height: 980,
            center: true,
            resizable: true,
            decorations: false,
          });
          console.log("✅ Fenêtre DVD créée avec succès");
        } catch (error) {
          console.error("❌ Erreur création fenêtre DVD:", error);
          // Réafficher Preview si l'erreur
          await appWindow.show();
          throw error; // Re-throw pour que ça soit catchable au niveau principal
        }
        return;
      }

      if (context.jobId) {
        await updateJobSettings(context.jobId, finalSettings);
      } else {
        for (const path of batchTargets) {
          await addJob(path, finalSettings);
        }
      }

      // Nettoyer le SRT exporté du contexte après utilisation
      if (context.srtPath) {
        localStorage.removeItem("animegui-dvdsubs-context");
      }

      await appWindow.close();
    } catch (error) {
      console.error("❌ Erreur dans handleConfirm:", error);
      alert(`Erreur: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsConfirming(false);
    }
  };

  // Affichage de la page de prévisualisation
  if (!context) {
    return (
      <main className="preview-page">
        <div className="preview-empty-page">{t("preview.noContext")}</div>
      </main>
    );
  }

  return (
    <main className="preview-page">
      <section className="preview-window">
        {/* Barre de titre */}
        <header className="preview-titlebar">
          <div
            className="preview-titlebar-left"
            onMouseDown={(e) => {
              if (e.button === 0) void appWindow.startDragging();
            }}
            onDoubleClick={() => void appWindow.toggleMaximize()}
          >
            <span className="preview-title">{t("preview.title")}</span>
            <span className="preview-filepath" title={context.inputPath}>
              {sourceName}
            </span>
            {batchTargets.length > 1 ? (
              <span className="preview-filepath">
                {t("preview.batch", { count: batchTargets.length })}
              </span>
            ) : null}
          </div>
          <div
            className="window-controls"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="window-btn window-btn-min"
              type="button"
              aria-label="Minimize"
              onClick={() => void appWindow.minimize()}
            />
            <button
              className="window-btn window-btn-max"
              type="button"
              aria-label="Maximize"
              onClick={() => void appWindow.toggleMaximize()}
            />
            <button
              className="window-btn window-btn-close"
              type="button"
              aria-label="Close"
              onClick={() => void appWindow.close()}
            />
          </div>
        </header>

        {/* Barre de contrôle */}
        <div className="preview-controls-bar">
          {/* Slider de cadre */}
          <div className="preview-frame-row">
            <span className="preview-frame-label">{t("preview.frame")}</span>
            <Slider
              min={0}
              max={Math.max(0, frameTotal - 1)}
              step={1}
              value={frameIndex}
              onValueChange={setFrameIndex}
            />
            <span className="preview-frame-value">{frameLabel}</span>
          </div>

          {/* Boutons de contrôle */}
          <div className="preview-toggle-row">
            <label className="preview-toggle-chip">
              <Switch checked={context.settings.auto_deinterlace} disabled />
              <span>{t("settings.autoDeinterlace")}</span>
            </label>
            <Button
              variant="secondary"
              className="btn-sm"
              onClick={() => setPreviewCropApplied(manualCropString)}
              disabled={isLoading}
            >
              {t("preview.applyCropPreview")}
            </Button>
          </div>

          {/* Contrôles de crop précise */}
          <div className="preview-crop-editor">
            {/* Presets */}
            <div className="preview-crop-presets">
              {CROP_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="preset-btn"
                  title={preset.description}
                  onClick={() => {
                    const newEdges = preset.apply(sourceWidth, sourceHeight);
                    setEdges((prev) => ({ ...prev, ...newEdges }));
                    setHasUserAdjustedCrop(true);
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            {/* Grille de saisie numérique de crop */}
            <div className="preview-crop-inputs">
              {(["left", "right", "top", "bottom"] as Edge[]).map((edge) => (
                <label
                  key={edge}
                  className={`preview-crop-field ${selectedEdge === edge ? "is-selected" : ""}`}
                  onClick={() =>
                    setSelectedEdge(selectedEdge === edge ? null : edge)
                  }
                >
                  <span className="preview-crop-label">
                    {edgeLabel(edge).toUpperCase()}
                  </span>
                  <input
                    type="number"
                    className="preview-crop-input"
                    min={0}
                    max={maxEdge(edge)}
                    step={2}
                    value={edges[edge]}
                    onChange={(e) => setEdgeValue(edge, Number(e.target.value))}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <div className="preview-crop-nudges">
                    <button
                      type="button"
                      title="-10px"
                      onClick={(e) => {
                        e.stopPropagation();
                        nudgeEdge(edge, -10);
                      }}
                    >
                      −10
                    </button>
                    <button
                      type="button"
                      title="-2px"
                      onClick={(e) => {
                        e.stopPropagation();
                        nudgeEdge(edge, -2);
                      }}
                    >
                      −2
                    </button>
                    <button
                      type="button"
                      title="+2px"
                      onClick={(e) => {
                        e.stopPropagation();
                        nudgeEdge(edge, +2);
                      }}
                    >
                      +2
                    </button>
                    <button
                      type="button"
                      title="+10px"
                      onClick={(e) => {
                        e.stopPropagation();
                        nudgeEdge(edge, +10);
                      }}
                    >
                      +10
                    </button>
                  </div>
                </label>
              ))}
            </div>

            {/* Résultat + Astuce clavier de contrôle */}
            <div className="preview-crop-result">
              <span className="preview-pill">
                <b>{t("preview.result")}</b>
                <em>
                  {cropResult.width}×{cropResult.height}
                </em>
              </span>
              <span className="preview-pill">
                <b>source</b>
                <em>
                  {sourceWidth}×{sourceHeight}
                </em>
              </span>
              {selectedEdge && (
                <span className="preview-crop-keyboard-hint">
                  ↑↓←→ : ±2px · Shift : ±10px · Alt : ±1px
                </span>
              )}
            </div>
          </div>

          {/* Sélecteurs de track */}
          <div className="preview-track-grid">
            <label className="field select-field">
              <span>{t("preview.audioTrack")}</span>
              <Select
                value={audioSelection}
                options={audioOptions}
                onValueChange={setAudioSelection}
              />
            </label>
            <label className="field select-field">
              <span>{t("preview.subtitleTrack")}</span>
              <Select
                value={subtitleSelection}
                options={subtitleOptions}
                onValueChange={(v) => {
                  setSubtitleSelection(v);
                  if (v === "all" || v === "none")
                    setSubtitleOutputFormat("copy");
                }}
              />
            </label>
            <label className="field select-field">
              <span>{t("preview.subtitleFormat")}</span>
              <Select
                value={subtitleOutputFormat}
                options={subtitleOutputOptions}
                onValueChange={(v) =>
                  setSubtitleOutputFormat(v as "copy" | "srt")
                }
              />
            </label>
            <span className="preview-track-meta">
              {isAnalyzingTracks
                ? t("preview.detectingTracks")
                : t("preview.audioCount", {
                  audio: analysis?.audio_tracks.length ?? 0,
                  subs: analysis?.subtitle_tracks.length ?? 0,
                })}
            </span>
            {subtitleSelection !== "all" &&
              subtitleSelection !== "none" &&
              dvdSubtitleSelected && (
                <span className="preview-track-warning">
                  {t("preview.dvdSubtitleRouted")}
                </span>
              )}
            {subtitleSelection !== "all" &&
              subtitleSelection !== "none" &&
              imageSubBlocked && (
                <span className="preview-track-warning">
                  {t("preview.imageSubsWarning")} ({selectedSubtitleCodec})
                </span>
              )}
          </div>

          {/* Pilules d'information */}
          <div className="preview-crop-pills">
            <span className="preview-pill">
              <b>{t("preview.applied")}</b>
              <em>{appliedCrop ?? "-"}</em>
            </span>
            <span className="preview-pill">
              <b>{t("preview.manual")}</b>
              <em>{manualCropEnabled ? manualCropString : "-"}</em>
            </span>
            <span className="preview-pill">
              <b>{t("preview.source")}</b>
              <em>
                {sourceWidth}×{sourceHeight}
              </em>
            </span>
            <span className="preview-pill">
              <b>{t("preview.audio")}</b>
              <em>{audioSelection}</em>
            </span>
            <span className="preview-pill">
              <b>{t("preview.subs")}</b>
              <em>{subtitleSelection}</em>
            </span>
            <span className="preview-pill">
              <b>{t("preview.subFmt")}</b>
              <em>{subtitleOutputFormat}</em>
            </span>
          </div>
        </div>

        {/* Panes d'image */}
        <div className="preview-grid">
          <div className="preview-pane">
            <div className="preview-pane-head">
              <h4>{t("preview.original")}</h4>
              <span className="preview-badge preview-badge-orig">
                {sourceWidth}×{sourceHeight}
              </span>
            </div>
            {showLoading ? (
              <Skeleton className="preview-skeleton" />
            ) : originalDataUrl ? (
              <div className="preview-image-wrap" ref={imageWrapRef}>
                <img
                  className="preview-original-image"
                  ref={origImgRef}
                  src={originalDataUrl}
                  alt={t("preview.original")}
                />
                {manualCropEnabled && (
                  <>
                    {/* Gauche */}
                    <div
                      className={`crop-line v ${selectedEdge === "left" ? "is-active" : ""}`}
                      style={{
                        left: `${leftPx}px`,
                        top: `${imageDisplayRect.offsetY}px`,
                        height: `${imageDisplayRect.height}px`,
                      }}
                      onMouseDown={() => {
                        setDraggingEdge("left");
                        setSelectedEdge("left");
                      }}
                    >
                      <span className="crop-line-label">{edges.left}px</span>
                    </div>
                    {/* Droite */}
                    <div
                      className={`crop-line v ${selectedEdge === "right" ? "is-active" : ""}`}
                      style={{
                        left: `${rightPx}px`,
                        top: `${imageDisplayRect.offsetY}px`,
                        height: `${imageDisplayRect.height}px`,
                      }}
                      onMouseDown={() => {
                        setDraggingEdge("right");
                        setSelectedEdge("right");
                      }}
                    >
                      <span className="crop-line-label">{edges.right}px</span>
                    </div>
                    {/* Haut */}
                    <div
                      className={`crop-line h ${selectedEdge === "top" ? "is-active" : ""}`}
                      style={{
                        top: `${topPx}px`,
                        left: `${imageDisplayRect.offsetX}px`,
                        width: `${imageDisplayRect.width}px`,
                      }}
                      onMouseDown={() => {
                        setDraggingEdge("top");
                        setSelectedEdge("top");
                      }}
                    >
                      <span className="crop-line-label">{edges.top}px</span>
                    </div>
                    {/* Bas */}
                    <div
                      className={`crop-line h ${selectedEdge === "bottom" ? "is-active" : ""}`}
                      style={{
                        top: `${bottomPx}px`,
                        left: `${imageDisplayRect.offsetX}px`,
                        width: `${imageDisplayRect.width}px`,
                      }}
                      onMouseDown={() => {
                        setDraggingEdge("bottom");
                        setSelectedEdge("bottom");
                      }}
                    >
                      <span className="crop-line-label">{edges.bottom}px</span>
                    </div>
                    {/* Zone de crop */}
                    <div
                      className="crop-area-overlay"
                      style={{
                        left: `${leftPx}px`,
                        top: `${topPx}px`,
                        width: `${rightPx - leftPx}px`,
                        height: `${bottomPx - topPx}px`,
                      }}
                    />
                  </>
                )}
              </div>
            ) : (
              <div className="preview-empty">{t("preview.noImage")}</div>
            )}
          </div>

          <div className="preview-pane">
            <div className="preview-pane-head">
              <h4>RealCUGAN</h4>
              <span className="preview-badge preview-badge-up">
                {upscaledWidth}×{upscaledHeight}
              </span>
            </div>
            {showLoading ? (
              <Skeleton className="preview-skeleton" />
            ) : upscaledDataUrl ? (
              <img
                className="preview-upscaled-image"
                src={upscaledDataUrl}
                alt="Upscaled frame"
              />
            ) : (
              <div className="preview-empty">{t("preview.noImage")}</div>
            )}
          </div>
        </div>

        {/* ── Footer ── */}
        <footer className="preview-footer">
          <div className="preview-status">
            <span
              className={`preview-status-dot ${showLoading ? "loading" : "ready"}`}
            />
            <span>
              {showLoading
                ? t("preview.loading")
                : t("preview.ready", { frame: frameLabel })}
            </span>
          </div>
          <div className="preview-footer-actions">
            <Button
              variant="secondary"
              className="btn-sm"
              onClick={() => setFrameIndex((v) => Math.max(0, v - 1))}
              disabled={frameIndex <= 0 || isLoading}
            >
              {t("preview.prev")}
            </Button>
            <Button
              variant="secondary"
              className="btn-sm"
              onClick={() =>
                setFrameIndex((v) => Math.min(frameTotal - 1, v + 1))
              }
              disabled={frameIndex >= frameTotal - 1 || isLoading}
            >
              {t("preview.next")}
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={isLoading || isConfirming || !context.inputPath}
            >
              {isConfirming
                ? t("preview.save")
                : shouldOpenDvdSubtitleWindow
                  ? t("preview.openDvdTool")
                  : context.jobId
                    ? t("preview.applyJob")
                    : batchTargets.length > 1
                      ? t("preview.addBatch", { count: batchTargets.length })
                      : t("preview.addQueue")}
            </Button>
          </div>
        </footer>
      </section>
    </main>
  );
}
