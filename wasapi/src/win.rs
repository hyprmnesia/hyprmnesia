// Windows WASAPI loopback capture.
//
// Captures the default (or named) render endpoint via a shared-mode loopback
// stream. The WASAPI calls follow the wasapi-rs loopback example: opening a
// *render* device with `Direction::Capture` enables the loopback flag, which
// taps the engine mix and keeps producing audio even when the audible endpoint
// is muted or its volume is zero.
//
// The endpoint mix format is typically 32-bit float, stereo, 44.1/48 kHz. We
// downmix to mono and resample to the requested rate (default 16 kHz) with a
// small box-averaging + linear-interpolation resampler — adequate for speech
// ASR and dependency-free — then emit s16le bytes to stdout, matching the PCM
// stream the TypeScript pipeline reads from ffmpeg.

use std::collections::VecDeque;
use std::io::{self, Write};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use wasapi::{get_default_device, Direction, SampleType, StreamMode};

const DEFAULT_RATE: u32 = 16_000;
const EVENT_WAIT_MS: u32 = 2_000;
const SILENCE_GAP_TOLERANCE_MS: u64 = 100;

struct Args {
    rate: u32,
    device: Option<String>,
}

fn parse_args() -> Result<Args> {
    let mut rate = DEFAULT_RATE;
    let mut device = None;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--rate" => {
                let v = it.next().context("--rate requires a value")?;
                rate = v.parse().with_context(|| format!("invalid --rate: {v}"))?;
            }
            "--device" => {
                device = Some(it.next().context("--device requires a value")?);
            }
            other => return Err(anyhow!("unknown argument: {other}")),
        }
    }
    if rate == 0 {
        return Err(anyhow!("--rate must be greater than zero"));
    }
    Ok(Args { rate, device })
}

fn pick_device(name: &Option<String>) -> Result<wasapi::Device> {
    if let Some(want) = name {
        let collection = wasapi::DeviceCollection::new(&Direction::Render)
            .map_err(|e| anyhow!("enumerate render devices: {e}"))?;
        let count = collection
            .get_nbr_devices()
            .map_err(|e| anyhow!("count render devices: {e}"))?;
        for i in 0..count {
            let dev = collection
                .get_device_at_index(i)
                .map_err(|e| anyhow!("open render device {i}: {e}"))?;
            if let Ok(friendly) = dev.get_friendlyname() {
                if friendly.eq_ignore_ascii_case(want) {
                    return Ok(dev);
                }
            }
        }
        return Err(anyhow!("render device '{want}' not found"));
    }
    get_default_device(&Direction::Render).map_err(|e| anyhow!("default render device: {e}"))
}

// Mono linear-interpolation resampler that keeps fractional position across
// packets, so packet boundaries don't introduce clicks. For downsampling it
// also box-averages the source samples spanned by each output step, which
// gives basic anti-aliasing (e.g. 48k -> 16k).
struct Resampler {
    ratio: f64, // src samples per output sample
    pos: f64,
    last: f32,
    history: Vec<f32>,
}

impl Resampler {
    fn new(src_rate: u32, dst_rate: u32) -> Self {
        Self {
            ratio: src_rate as f64 / dst_rate as f64,
            pos: 0.0,
            last: 0.0,
            history: Vec::new(),
        }
    }

    fn push(&mut self, src: &[f32], out: &mut Vec<i16>) {
        if src.is_empty() {
            return;
        }
        // Carry one previous sample so interpolation can reach back across the
        // packet boundary.
        self.history.clear();
        self.history.push(self.last);
        self.history.extend_from_slice(src);
        let samples = &self.history;
        // `pos` is indexed against `src`; offset by 1 for the carried sample.
        if self.ratio > 1.0 {
            // Downsampling: box-average across the step.
            while self.pos < src.len() as f64 {
                let end = (self.pos + self.ratio).min(src.len() as f64);
                let mut acc = 0.0f32;
                let mut n = 0u32;
                let mut k = self.pos.floor() as usize;
                while (k as f64) < end {
                    acc += samples[k + 1];
                    n += 1;
                    k += 1;
                }
                // n >= 1: pos.floor() < end because end > pos.
                out.push(to_i16(acc / n as f32));
                self.pos += self.ratio;
            }
        } else {
            // Upsampling or same-rate: linear interpolation.
            while self.pos < src.len() as f64 {
                let lo = self.pos.floor();
                let i = lo as usize + 1;
                let a = samples[i - 1];
                let b = samples[i];
                out.push(to_i16(a + (b - a) * (self.pos - lo) as f32));
                self.pos += self.ratio;
            }
        }
        self.pos -= src.len() as f64;
        self.last = src[src.len() - 1];
    }
}

fn to_i16(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    (clamped * i16::MAX as f32) as i16
}

fn duration_to_samples(duration: Duration, sample_rate: u32) -> usize {
    let samples = duration.as_nanos().saturating_mul(sample_rate as u128) / 1_000_000_000u128;
    samples.min(usize::MAX as u128) as usize
}

fn samples_to_duration(samples: usize, sample_rate: u32) -> Duration {
    Duration::from_secs_f64(samples as f64 / sample_rate as f64)
}

fn write_silence<W: Write>(writer: &mut W, samples: usize) -> Result<()> {
    let mut remaining = samples.saturating_mul(2);
    let zeros = [0u8; 8192];
    while remaining > 0 {
        let take = remaining.min(zeros.len());
        writer
            .write_all(&zeros[..take])
            .context("write silent PCM to stdout (downstream closed?)")?;
        remaining -= take;
    }
    writer.flush().ok();
    Ok(())
}

// Decode one interleaved frame block (bytes) into mono f32 samples.
fn decode_mono(
    bytes: &[u8],
    channels: usize,
    bytes_per_sample: usize,
    is_float: bool,
    out: &mut Vec<f32>,
) {
    let frame_bytes = channels * bytes_per_sample;
    if frame_bytes == 0 {
        return;
    }
    for frame in bytes.chunks_exact(frame_bytes) {
        let mut sum = 0.0f32;
        for ch in 0..channels {
            let s = &frame[ch * bytes_per_sample..(ch + 1) * bytes_per_sample];
            sum += sample_to_f32(s, is_float);
        }
        out.push(sum / channels as f32);
    }
}

fn sample_to_f32(bytes: &[u8], is_float: bool) -> f32 {
    if is_float && bytes.len() == 4 {
        return f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    }
    match bytes.len() {
        2 => i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / i16::MAX as f32,
        4 => i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / i32::MAX as f32,
        3 => {
            let v = (bytes[0] as i32) | ((bytes[1] as i32) << 8) | ((bytes[2] as i32) << 16);
            let v = (v << 8) >> 8; // sign-extend 24-bit
            v as f32 / 8_388_607.0
        }
        _ => 0.0,
    }
}

pub fn run() -> Result<()> {
    let args = parse_args()?;

    wasapi::initialize_mta()
        .ok()
        .map_err(|e| anyhow!("initialize COM (MTA): {e}"))?;

    let device = pick_device(&args.device)?;

    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| anyhow!("get audio client: {e}"))?;
    let format = audio_client
        .get_mixformat()
        .map_err(|e| anyhow!("get mix format: {e}"))?;

    let channels = format.get_nchannels() as usize;
    let src_rate = format.get_samplespersec();
    let bits = format.get_bitspersample() as usize;
    let bytes_per_sample = bits / 8;
    let is_float = matches!(
        format
            .get_subformat()
            .map_err(|e| anyhow!("get sample subformat: {e}"))?,
        SampleType::Float
    );
    let block_align = format.get_blockalign() as usize;

    let (default_period, _min_period) = audio_client
        .get_device_period()
        .map_err(|e| anyhow!("get device period: {e}"))?;
    // Opening a Render device with Direction::Capture in shared mode makes
    // wasapi-rs set AUDCLNT_STREAMFLAGS_LOOPBACK. We keep the engine mix format
    // (autoconvert off) and do our own downmix/resample.
    audio_client
        .initialize_client(
            &format,
            &Direction::Capture,
            &StreamMode::EventsShared {
                autoconvert: false,
                buffer_duration_hns: default_period,
            },
        )
        .map_err(|e| anyhow!("initialize loopback client: {e}"))?;

    let event = audio_client
        .set_get_eventhandle()
        .map_err(|e| anyhow!("set event handle: {e}"))?;
    let capture = audio_client
        .get_audiocaptureclient()
        .map_err(|e| anyhow!("get capture client: {e}"))?;

    // Keep stderr quiet on the happy path: the parent treats any stderr output
    // on a non-zero exit as an error, and logs the selected backend/device from
    // the `started` event instead. Only real failures (propagated as Err) reach
    // stderr.
    audio_client
        .start_stream()
        .map_err(|e| anyhow!("start loopback stream: {e}"))?;

    let mut resampler = Resampler::new(src_rate, args.rate);
    let mut queue: VecDeque<u8> = VecDeque::new();
    let mut mono: Vec<f32> = Vec::new();
    let mut out: Vec<i16> = Vec::new();
    let stdout = io::stdout();
    let mut writer = io::BufWriter::new(stdout.lock());
    let mut emitted_until = Instant::now();

    loop {
        // Shared-mode loopback only produces packets while something is being
        // rendered. During system silence WASAPI does not signal the event, but
        // the TypeScript pipeline still needs continuous PCM so chunk_ms stays
        // wall-clock bounded.
        if event.wait_for_event(EVENT_WAIT_MS).is_err() {
            let now = Instant::now();
            write_silence(
                &mut writer,
                duration_to_samples(now.duration_since(emitted_until), args.rate),
            )?;
            emitted_until = now;
            continue;
        }

        capture
            .read_from_device_to_deque(&mut queue)
            .map_err(|e| anyhow!("read loopback packet: {e}"))?;

        // Drain whole frames; keep any trailing partial frame for next read.
        let usable = (queue.len() / block_align) * block_align;
        if usable == 0 {
            let now = Instant::now();
            write_silence(
                &mut writer,
                duration_to_samples(now.duration_since(emitted_until), args.rate),
            )?;
            emitted_until = now;
            continue;
        }
        let bytes: Vec<u8> = queue.drain(..usable).collect();
        mono.clear();
        decode_mono(&bytes, channels, bytes_per_sample, is_float, &mut mono);
        out.clear();
        resampler.push(&mono, &mut out);
        if out.is_empty() {
            let now = Instant::now();
            write_silence(
                &mut writer,
                duration_to_samples(now.duration_since(emitted_until), args.rate),
            )?;
            emitted_until = now;
            continue;
        }
        let now = Instant::now();
        let elapsed = now.duration_since(emitted_until);
        let packet_duration = samples_to_duration(out.len(), args.rate);
        let tolerance = Duration::from_millis(SILENCE_GAP_TOLERANCE_MS);
        if elapsed > packet_duration + tolerance {
            write_silence(
                &mut writer,
                duration_to_samples(elapsed - packet_duration, args.rate),
            )?;
        }
        let raw: &[u8] = i16_le_bytes(&out);
        writer
            .write_all(raw)
            .context("write PCM to stdout (downstream closed?)")?;
        // Flush each packet so the parent's reader gets audio at capture latency
        // (~10 ms) rather than waiting for the BufWriter to fill.
        writer.flush().ok();
        emitted_until = now;
    }
}

// Reinterpret i16 samples as little-endian bytes without an extra dependency.
// Safe on little-endian targets (all supported Windows arches); WASAPI itself
// only runs on little-endian Windows.
fn i16_le_bytes(samples: &[i16]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(samples.as_ptr() as *const u8, samples.len() * 2) }
}
