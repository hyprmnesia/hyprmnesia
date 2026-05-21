use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
    sync::{Arc, Mutex},
    thread,
    time::Instant,
};
use webrtc_vad::{SampleRate, Vad, VadMode};

const DEFAULT_MODEL: &str = "parakeet-tdt-0.6b-v3";
const DEFAULT_SAMPLE_RATE: u32 = 16_000;
const DEFAULT_MIN_SEGMENT_MS: u64 = 750;
const DEFAULT_TARGET_SEGMENT_MS: u64 = 4_000;
const DEFAULT_MAX_SEGMENT_MS: u64 = 6_000;
const DEFAULT_SILENCE_MS: u64 = 700;
const DEFAULT_RMS_GATE: f32 = 0.003;

type SharedOut = Arc<Mutex<io::Stdout>>;
type SharedModel = Arc<Mutex<ModelSlot>>;

enum ModelSlot {
    Empty,
    Loading,
    Ready(audiopipe::Model),
    Failed(String),
}

#[derive(Clone)]
struct Config {
    model: String,
    sample_rate: u32,
    min_segment_ms: u64,
    target_segment_ms: u64,
    max_segment_ms: u64,
    silence_ms: u64,
    rms_gate: f32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            model: DEFAULT_MODEL.to_string(),
            sample_rate: DEFAULT_SAMPLE_RATE,
            min_segment_ms: DEFAULT_MIN_SEGMENT_MS,
            target_segment_ms: DEFAULT_TARGET_SEGMENT_MS,
            max_segment_ms: DEFAULT_MAX_SEGMENT_MS,
            silence_ms: DEFAULT_SILENCE_MS,
            rms_gate: DEFAULT_RMS_GATE,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Request {
    Init {
        model: Option<String>,
        sample_rate: Option<u32>,
        min_segment_ms: Option<u64>,
        target_segment_ms: Option<u64>,
        max_segment_ms: Option<u64>,
        silence_ms: Option<u64>,
        rms_gate: Option<f32>,
    },
    Audio {
        source: String,
        chunk_id: String,
        at: u64,
        sample_rate: u32,
        pcm_b64: String,
    },
    Flush {
        id: Option<String>,
        source: Option<String>,
    },
    Shutdown,
}

struct AudioFrame {
    source: String,
    chunk_id: String,
    at: u64,
    sample_rate: u32,
    samples: Vec<f32>,
}

struct SegmentAudio {
    source: String,
    chunk_id: String,
    start_at: u64,
    end_at: u64,
    samples: Vec<f32>,
}

struct SourceVad {
    vad: Vad,
    segment: Vec<f32>,
    source: String,
    chunk_id: Option<String>,
    start_at: Option<u64>,
    end_at: Option<u64>,
    silence_ms: u64,
}

impl SourceVad {
    fn new(source: &str) -> Self {
        let mode = if source == "mic" {
            // Real microphones are noisier and less consistent than mixer
            // capture. A less aggressive VAD catches user speech that the
            // clean-system-audio setting was rejecting.
            VadMode::Quality
        } else {
            VadMode::Aggressive
        };
        Self {
            vad: Vad::new_with_rate_and_mode(SampleRate::Rate16kHz, mode),
            segment: Vec::new(),
            source: source.to_string(),
            chunk_id: None,
            start_at: None,
            end_at: None,
            silence_ms: 0,
        }
    }

    fn push(&mut self, frame: AudioFrame, cfg: &Config) -> Vec<SegmentAudio> {
        let mut ready = Vec::new();
        if self
            .chunk_id
            .as_ref()
            .is_some_and(|chunk_id| chunk_id != &frame.chunk_id)
        {
            if let Some(segment) = self.take(cfg, false) {
                ready.push(segment);
            }
        }

        let frame_ms = samples_to_ms(frame.samples.len(), frame.sample_rate);
        let frame_end = frame.at.saturating_add(frame_ms);
        let rms = rms(&frame.samples);
        let speech = rms >= cfg.rms_gate && self.is_voice(&frame.samples);

        if speech {
            if self.segment.is_empty() {
                self.source = frame.source.clone();
                self.chunk_id = Some(frame.chunk_id.clone());
                self.start_at = Some(frame.at);
            }
            self.segment.extend_from_slice(&frame.samples);
            self.end_at = Some(frame_end);
            self.silence_ms = 0;

            let duration = samples_to_ms(self.segment.len(), cfg.sample_rate);
            if duration >= cfg.max_segment_ms || duration >= cfg.target_segment_ms {
                if let Some(segment) = self.take(cfg, false) {
                    ready.push(segment);
                }
            }
        } else if !self.segment.is_empty() {
            // Once speech has started, keep short non-voice frames in the
            // segment. Normal mic speech contains pauses, breaths, and
            // unvoiced consonants; dropping those frames made user speech too
            // short to pass `min_segment_ms`, so mic transcripts disappeared.
            self.segment.extend_from_slice(&frame.samples);
            self.end_at = Some(frame_end);
            self.silence_ms = self.silence_ms.saturating_add(frame_ms);
            if self.silence_ms >= cfg.silence_ms {
                if let Some(segment) = self.take(cfg, false) {
                    ready.push(segment);
                }
            }
        }

        ready
    }

    fn flush(&mut self, cfg: &Config) -> Option<SegmentAudio> {
        self.take(cfg, true)
    }

    fn is_voice(&mut self, samples: &[f32]) -> bool {
        let pcm: Vec<i16> = samples
            .iter()
            .map(|sample| {
                let clamped = sample.clamp(-1.0, 1.0);
                (clamped * i16::MAX as f32) as i16
            })
            .collect();
        self.vad.is_voice_segment(&pcm).unwrap_or(false)
    }

    fn take(&mut self, cfg: &Config, force: bool) -> Option<SegmentAudio> {
        if self.segment.is_empty() {
            return None;
        }
        let duration = samples_to_ms(self.segment.len(), cfg.sample_rate);
        if !force && duration < cfg.min_segment_ms {
            self.reset();
            return None;
        }
        let samples = std::mem::take(&mut self.segment);
        let source = self.source.clone();
        let chunk_id = self.chunk_id.take()?;
        let start_at = self.start_at.take()?;
        let end_at = self.end_at.take().unwrap_or(start_at);
        self.silence_ms = 0;
        Some(SegmentAudio {
            source,
            chunk_id,
            start_at,
            end_at,
            samples,
        })
    }

    fn reset(&mut self) {
        self.segment.clear();
        self.chunk_id = None;
        self.start_at = None;
        self.end_at = None;
        self.silence_ms = 0;
    }
}

fn main() -> Result<()> {
    let out = Arc::new(Mutex::new(io::stdout()));
    let model = Arc::new(Mutex::new(ModelSlot::Empty));
    let mut cfg = Config::default();
    let mut sources: HashMap<String, SourceVad> = HashMap::new();

    for line in io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(err) => {
                emit(
                    &out,
                    json!({ "type": "error", "message": format!("invalid request: {err}") }),
                );
                continue;
            }
        };

        match req {
            Request::Init {
                model: model_name,
                sample_rate,
                min_segment_ms,
                target_segment_ms,
                max_segment_ms,
                silence_ms,
                rms_gate,
            } => {
                cfg.model = model_name.unwrap_or_else(|| DEFAULT_MODEL.to_string());
                cfg.sample_rate = sample_rate.unwrap_or(DEFAULT_SAMPLE_RATE);
                cfg.min_segment_ms = min_segment_ms.unwrap_or(DEFAULT_MIN_SEGMENT_MS);
                cfg.target_segment_ms = target_segment_ms.unwrap_or(DEFAULT_TARGET_SEGMENT_MS);
                cfg.max_segment_ms = max_segment_ms.unwrap_or(DEFAULT_MAX_SEGMENT_MS);
                cfg.silence_ms = silence_ms.unwrap_or(DEFAULT_SILENCE_MS);
                cfg.rms_gate = rms_gate.unwrap_or(DEFAULT_RMS_GATE);
                start_model_loader(cfg.model.clone(), out.clone(), model.clone());
            }
            Request::Audio {
                source,
                chunk_id,
                at,
                sample_rate,
                pcm_b64,
            } => {
                if !model_ready(&model) {
                    continue;
                }
                if sample_rate != cfg.sample_rate {
                    emit(
                        &out,
                        json!({
                            "type": "error",
                            "source": source,
                            "message": format!("unexpected sample rate {sample_rate}; expected {}", cfg.sample_rate),
                        }),
                    );
                    continue;
                }
                let frame = match decode_audio(source, chunk_id, at, sample_rate, &pcm_b64) {
                    Ok(frame) => frame,
                    Err(err) => {
                        emit(&out, json!({ "type": "error", "message": err.to_string() }));
                        continue;
                    }
                };
                let source_state = sources
                    .entry(frame.source.clone())
                    .or_insert_with(|| SourceVad::new(&frame.source));
                for segment in source_state.push(frame, &cfg) {
                    transcribe_segment(&out, &model, &cfg, segment);
                }
            }
            Request::Flush { id, source } => {
                if let Some(source) = source {
                    if let Some(source_state) = sources.get_mut(&source) {
                        if let Some(segment) = source_state.flush(&cfg) {
                            transcribe_segment(&out, &model, &cfg, segment);
                        }
                    }
                } else {
                    for source_state in sources.values_mut() {
                        if let Some(segment) = source_state.flush(&cfg) {
                            transcribe_segment(&out, &model, &cfg, segment);
                        }
                    }
                }
                emit(&out, json!({ "type": "flushed", "id": id }));
            }
            Request::Shutdown => {
                for source_state in sources.values_mut() {
                    if let Some(segment) = source_state.flush(&cfg) {
                        transcribe_segment(&out, &model, &cfg, segment);
                    }
                }
                emit(
                    &out,
                    json!({ "type": "status", "status": "stopped", "engine": engine_name(&cfg) }),
                );
                break;
            }
        }
    }

    Ok(())
}

fn start_model_loader(name: String, out: SharedOut, slot: SharedModel) {
    {
        let mut guard = slot.lock().expect("model lock");
        if matches!(&*guard, ModelSlot::Loading | ModelSlot::Ready(_)) {
            return;
        }
        *guard = ModelSlot::Loading;
    }

    emit(
        &out,
        json!({ "type": "status", "status": "loading", "engine": engine_name_for(&name), "message": "loading Parakeet" }),
    );
    thread::spawn(move || {
        let loaded = match audiopipe::Model::from_pretrained_cache_only(&name) {
            Ok(model) => Ok(model),
            Err(err) if err.is_model_not_cached() => {
                emit(
                    &out,
                    json!({
                        "type": "status",
                        "status": "downloading",
                        "engine": engine_name_for(&name),
                        "message": "downloading Parakeet model"
                    }),
                );
                audiopipe::Model::from_pretrained(&name)
            }
            Err(err) => Err(err),
        };

        match loaded {
            Ok(model) => {
                {
                    let mut guard = slot.lock().expect("model lock");
                    *guard = ModelSlot::Ready(model);
                }
                emit(
                    &out,
                    json!({ "type": "ready", "engine": engine_name_for(&name), "model": name }),
                );
            }
            Err(err) => {
                {
                    let mut guard = slot.lock().expect("model lock");
                    *guard = ModelSlot::Failed(err.to_string());
                }
                emit(
                    &out,
                    json!({
                        "type": "error",
                        "engine": engine_name_for(&name),
                        "message": format!("Parakeet model failed: {err}")
                    }),
                );
            }
        }
    });
}

fn model_ready(model: &SharedModel) -> bool {
    let guard = model.lock().expect("model lock");
    matches!(&*guard, ModelSlot::Ready(_))
}

fn transcribe_segment(out: &SharedOut, model: &SharedModel, cfg: &Config, segment: SegmentAudio) {
    if rms(&segment.samples) < cfg.rms_gate {
        return;
    }
    let start = Instant::now();
    let result = {
        let mut guard = model.lock().expect("model lock");
        match &mut *guard {
            ModelSlot::Ready(model) => model
                .transcribe_with_sample_rate(
                    &segment.samples,
                    cfg.sample_rate,
                    audiopipe::TranscribeOptions::default(),
                )
                .map_err(|err| anyhow!(err.to_string())),
            ModelSlot::Failed(err) => Err(anyhow!(err.clone())),
            _ => Err(anyhow!("Parakeet is not ready")),
        }
    };

    match result {
        Ok(result) => {
            let text = result.text.trim();
            if text.is_empty() {
                return;
            }
            emit(
                &out,
                json!({
                    "type": "segment_final",
                    "source": segment.source,
                    "chunk_id": segment.chunk_id,
                    "start_at": segment.start_at,
                    "end_at": segment.end_at,
                    "text": text,
                    "engine": engine_name(cfg),
                    "transcribe_ms": start.elapsed().as_millis() as u64,
                }),
            );
        }
        Err(err) => emit(
            &out,
            json!({
                "type": "error",
                "source": segment.source,
                "chunk_id": segment.chunk_id,
                "message": format!("Parakeet transcription failed: {err}"),
            }),
        ),
    }
}

fn decode_audio(
    source: String,
    chunk_id: String,
    at: u64,
    sample_rate: u32,
    pcm_b64: &str,
) -> Result<AudioFrame> {
    let pcm = BASE64.decode(pcm_b64).context("invalid base64 PCM")?;
    if pcm.len() % 2 != 0 {
        return Err(anyhow!("PCM frame has odd byte length"));
    }
    let samples = pcm
        .chunks_exact(2)
        .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32768.0)
        .collect();
    Ok(AudioFrame {
        source,
        chunk_id,
        at,
        sample_rate,
        samples,
    })
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum = samples.iter().map(|sample| sample * sample).sum::<f32>();
    (sum / samples.len() as f32).sqrt()
}

fn samples_to_ms(samples: usize, sample_rate: u32) -> u64 {
    ((samples as u64) * 1000) / sample_rate as u64
}

fn engine_name(cfg: &Config) -> String {
    engine_name_for(&cfg.model)
}

fn engine_name_for(model: &str) -> String {
    format!("parakeet:{model}")
}

fn emit(out: &SharedOut, value: serde_json::Value) {
    if let Ok(mut out) = out.lock() {
        let _ = writeln!(out, "{}", value);
        let _ = out.flush();
    }
}
