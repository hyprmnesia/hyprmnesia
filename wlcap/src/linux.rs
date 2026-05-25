// Linux/Wayland screen capture helper.
//
// Protocol (identical shape to hpm-sck, video-only):
//   stdin   : NDJSON Request (Start | Stop | Shutdown)
//   stdout  : NDJSON Event   (ready | started | stopped | frame | error | log)
//   stderr  : free-form diagnostic text (mirrored by the parent as warn logs)
//
// Capture path: org.freedesktop.portal.ScreenCast opens a persistent PipeWire
// stream (CreateSession → SelectSources → Start → OpenPipeWireRemote). A
// GStreamer pipeline (pipewiresrc ! videorate ! videoconvert ! pngenc/jpegenc !
// appsink) pulls already-encoded frames. `restore_token` is requested with
// persist_mode=until-revoked so the permission prompt only appears on first run;
// the parent persists the token across sessions and feeds it back on Start.

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::os::fd::AsRawFd;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{ObjectPath, OwnedFd, OwnedObjectPath, OwnedValue, Value};

type SharedOut = Arc<Mutex<io::Stdout>>;

const PORTAL_DEST: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const SCREENCAST_IFACE: &str = "org.freedesktop.portal.ScreenCast";
const REQUEST_IFACE: &str = "org.freedesktop.portal.Request";
const SESSION_IFACE: &str = "org.freedesktop.portal.Session";

// Source type bitmask (MONITOR), cursor + persist modes per the portal spec.
const SOURCE_TYPE_MONITOR: u32 = 1;
const CURSOR_MODE_EMBEDDED: u32 = 2;
const PERSIST_UNTIL_REVOKED: u32 = 2;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Request {
    Start(StartParams),
    Stop,
    Shutdown,
}

#[derive(Deserialize, Default)]
struct StartParams {
    #[serde(default)]
    frame_interval_ms: Option<u32>,
    #[serde(default)]
    image_format: Option<String>, // "png" | "jpeg"
    #[serde(default)]
    jpeg_quality: Option<u8>,
    #[serde(default)]
    restore_token: Option<String>,
}

#[derive(Clone, Copy)]
enum ImageFormat {
    Png,
    Jpeg,
}

impl ImageFormat {
    fn parse(value: Option<&str>) -> Self {
        match value.map(str::to_ascii_lowercase).as_deref() {
            Some("jpeg") | Some("jpg") => ImageFormat::Jpeg,
            _ => ImageFormat::Png,
        }
    }
}

struct Capture {
    pipeline: gst::Pipeline,
    conn: Connection,
    session: OwnedObjectPath,
    // Keep the PipeWire remote fd alive for the lifetime of the pipeline.
    _fd: OwnedFd,
}

impl Capture {
    fn close(self) {
        let _ = self.pipeline.set_state(gst::State::Null);
        if let Ok(session) = Proxy::new(
            &self.conn,
            PORTAL_DEST,
            self.session.as_ref(),
            SESSION_IFACE,
        ) {
            let _: Result<(), _> = session.call("Close", &());
        }
    }
}

pub fn run() -> Result<()> {
    gst::init().context("gstreamer init")?;

    let stdin = io::stdin();
    let out: SharedOut = Arc::new(Mutex::new(io::stdout()));

    emit(&out, json!({"type": "ready", "engine": "wlcap"}));

    let mut capture: Option<Capture> = None;
    let mut token_counter: u32 = 0;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(err) => {
                emit(
                    &out,
                    json!({"type": "error", "at": now_ms(), "message": format!("stdin read: {err}")}),
                );
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(err) => {
                emit(
                    &out,
                    json!({"type": "error", "at": now_ms(), "message": format!("bad request: {err}")}),
                );
                continue;
            }
        };

        match req {
            Request::Start(params) => {
                if capture.is_some() {
                    emit(
                        &out,
                        json!({"type": "log", "at": now_ms(), "level": "warn", "message": "already running"}),
                    );
                    continue;
                }
                match start_capture(&out, &params, &mut token_counter) {
                    Ok((cap, restore_token)) => {
                        emit(
                            &out,
                            json!({
                                "type": "started",
                                "at": now_ms(),
                                "frame_interval_ms": params.frame_interval_ms.unwrap_or(5_000),
                                "restore_token": restore_token,
                            }),
                        );
                        capture = Some(cap);
                    }
                    Err(err) => {
                        emit(
                            &out,
                            json!({"type": "error", "at": now_ms(), "message": format!("start failed: {err:#}")}),
                        );
                    }
                }
            }
            Request::Stop => {
                if let Some(cap) = capture.take() {
                    cap.close();
                    emit(&out, json!({"type": "stopped", "at": now_ms()}));
                }
            }
            Request::Shutdown => {
                if let Some(cap) = capture.take() {
                    cap.close();
                }
                break;
            }
        }
    }

    Ok(())
}

fn start_capture(
    out: &SharedOut,
    params: &StartParams,
    token_counter: &mut u32,
) -> Result<(Capture, Option<String>)> {
    let conn = Connection::session().context("connect session bus")?;
    let screencast = Proxy::new(&conn, PORTAL_DEST, PORTAL_PATH, SCREENCAST_IFACE)
        .context("ScreenCast proxy")?;

    // CreateSession
    let mut opts: HashMap<String, Value> = HashMap::new();
    let create_token = next_token(token_counter);
    opts.insert("handle_token".into(), Value::from(create_token.clone()));
    opts.insert(
        "session_handle_token".into(),
        Value::from(next_token(token_counter)),
    );
    let create_results = portal_request(&conn, &screencast, "CreateSession", &opts, &create_token)?;
    let session_handle = create_results
        .get("session_handle")
        .and_then(value_as_string)
        .ok_or_else(|| anyhow!("portal returned no session_handle"))?;
    let session = ObjectPath::try_from(session_handle)
        .context("session handle is not an object path")?
        .into();

    // SelectSources (monitor, embedded cursor, persistent permission)
    let mut opts: HashMap<String, Value> = HashMap::new();
    let select_token = next_token(token_counter);
    opts.insert("handle_token".into(), Value::from(select_token.clone()));
    opts.insert("types".into(), Value::from(SOURCE_TYPE_MONITOR));
    opts.insert("multiple".into(), Value::from(false));
    opts.insert("cursor_mode".into(), Value::from(CURSOR_MODE_EMBEDDED));
    opts.insert("persist_mode".into(), Value::from(PERSIST_UNTIL_REVOKED));
    if let Some(token) = params.restore_token.as_deref() {
        if !token.is_empty() {
            opts.insert("restore_token".into(), Value::from(token));
        }
    }
    let _ = call_session_request(
        &conn,
        &screencast,
        "SelectSources",
        &session,
        &opts,
        &select_token,
    )?;

    // Start — yields the PipeWire node id and a fresh restore_token.
    let mut opts: HashMap<String, Value> = HashMap::new();
    let start_token = next_token(token_counter);
    opts.insert("handle_token".into(), Value::from(start_token.clone()));
    let start_results = call_start(&conn, &screencast, &session, &opts, &start_token)?;
    let node_id = first_node_id(start_results.get("streams"))?;
    let restore_token = start_results.get("restore_token").and_then(value_as_string);

    // OpenPipeWireRemote — the fd backing the GStreamer source.
    let open_opts: HashMap<String, Value> = HashMap::new();
    let fd: OwnedFd = screencast
        .call("OpenPipeWireRemote", &(&session, open_opts))
        .context("OpenPipeWireRemote")?;

    let pipeline = build_pipeline(out, params, fd.as_raw_fd(), node_id)?;
    pipeline
        .set_state(gst::State::Playing)
        .context("set pipeline playing")?;
    watch_bus(out, &pipeline);

    Ok((
        Capture {
            pipeline,
            conn,
            session,
            _fd: fd,
        },
        restore_token,
    ))
}

fn build_pipeline(
    out: &SharedOut,
    params: &StartParams,
    fd: i32,
    node_id: u32,
) -> Result<gst::Pipeline> {
    let format = ImageFormat::parse(params.image_format.as_deref());
    let interval = params.frame_interval_ms.unwrap_or(5_000).max(100);
    let (encoder, fmt_label, mime) = match format {
        ImageFormat::Png => ("pngenc".to_string(), "png", "image/png"),
        ImageFormat::Jpeg => {
            let q = params.jpeg_quality.unwrap_or(80).clamp(1, 100);
            (format!("jpegenc quality={q}"), "jpeg", "image/jpeg")
        }
    };

    // framerate = 1000 / interval_ms frames per second (GStreamer reduces the
    // fraction). videorate caps the source down to ~1 frame per interval.
    let desc = format!(
        "pipewiresrc fd={fd} path={node_id} do-timestamp=true keepalive-time=1000 ! \
         videorate ! video/x-raw,framerate=1000/{interval} ! videoconvert ! {encoder} ! \
         appsink name=sink max-buffers=2 drop=true sync=false"
    );

    let pipeline = gst::parse::launch(&desc)
        .context("build gstreamer pipeline")?
        .downcast::<gst::Pipeline>()
        .map_err(|_| anyhow!("parsed element is not a pipeline"))?;

    let appsink = pipeline
        .by_name("sink")
        .ok_or_else(|| anyhow!("appsink not found"))?
        .downcast::<gst_app::AppSink>()
        .map_err(|_| anyhow!("sink is not an appsink"))?;

    let sink_out = out.clone();
    appsink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                let (width, height) = sample
                    .caps()
                    .and_then(|c| c.structure(0))
                    .map(|s| {
                        (
                            s.get::<i32>("width").unwrap_or(0),
                            s.get::<i32>("height").unwrap_or(0),
                        )
                    })
                    .unwrap_or((0, 0));
                emit(
                    &sink_out,
                    json!({
                        "type": "frame",
                        "at": now_ms(),
                        "width": width,
                        "height": height,
                        "format": fmt_label,
                        "mime": mime,
                        "image_b64": BASE64.encode(map.as_slice()),
                    }),
                );
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    Ok(pipeline)
}

fn watch_bus(out: &SharedOut, pipeline: &gst::Pipeline) {
    let Some(bus) = pipeline.bus() else {
        return;
    };
    let bus_out = out.clone();
    std::thread::spawn(move || {
        use gst::MessageView;
        for msg in bus.iter_timed(gst::ClockTime::NONE) {
            match msg.view() {
                MessageView::Error(err) => {
                    emit(
                        &bus_out,
                        json!({
                            "type": "error",
                            "at": now_ms(),
                            "message": format!("gstreamer: {}", err.error()),
                        }),
                    );
                    break;
                }
                MessageView::Eos(_) => break,
                _ => {}
            }
        }
    });
}

// --- xdg-desktop-portal Request/Response helpers ---------------------------

// CreateSession-style call: one a{sv} argument, returns the Response results.
fn portal_request(
    conn: &Connection,
    proxy: &Proxy,
    method: &str,
    options: &HashMap<String, Value>,
    handle_token: &str,
) -> Result<HashMap<String, OwnedValue>> {
    let mut signals = subscribe_response(conn, handle_token)?;
    let _: OwnedObjectPath = proxy
        .call(method, options)
        .with_context(|| method.to_string())?;
    await_response(&mut signals, method)
}

// SelectSources-style call: (o session, a{sv} options).
fn call_session_request(
    conn: &Connection,
    proxy: &Proxy,
    method: &str,
    session: &OwnedObjectPath,
    options: &HashMap<String, Value>,
    handle_token: &str,
) -> Result<HashMap<String, OwnedValue>> {
    let mut signals = subscribe_response(conn, handle_token)?;
    let _: OwnedObjectPath = proxy
        .call(method, &(session, options))
        .with_context(|| method.to_string())?;
    await_response(&mut signals, method)
}

// Start: (o session, s parent_window, a{sv} options).
fn call_start(
    conn: &Connection,
    proxy: &Proxy,
    session: &OwnedObjectPath,
    options: &HashMap<String, Value>,
    handle_token: &str,
) -> Result<HashMap<String, OwnedValue>> {
    let mut signals = subscribe_response(conn, handle_token)?;
    let _: OwnedObjectPath = proxy
        .call("Start", &(session, "", options))
        .context("Start")?;
    await_response(&mut signals, "Start")
}

// Subscribe to the Request's Response signal *before* invoking the method so we
// never miss a fast reply. The request path is deterministic from the unique
// bus name and our handle_token.
fn subscribe_response(
    conn: &Connection,
    handle_token: &str,
) -> Result<zbus::blocking::proxy::SignalIterator<'static>> {
    let unique = conn
        .inner()
        .unique_name()
        .map(|n| n.as_str().to_string())
        .unwrap_or_default();
    let sender = unique.trim_start_matches(':').replace('.', "_");
    let path = format!("/org/freedesktop/portal/desktop/request/{sender}/{handle_token}");
    let proxy = Proxy::new(conn, PORTAL_DEST, path, REQUEST_IFACE).context("Request proxy")?;
    proxy.receive_signal("Response").context("receive Response")
}

fn await_response(
    signals: &mut zbus::blocking::proxy::SignalIterator<'static>,
    method: &str,
) -> Result<HashMap<String, OwnedValue>> {
    let msg = signals
        .next()
        .ok_or_else(|| anyhow!("{method}: no portal response"))?;
    let (response, results): (u32, HashMap<String, OwnedValue>) =
        msg.body().deserialize().context("decode Response")?;
    if response != 0 {
        bail!("{method}: portal request denied/cancelled (code {response})");
    }
    Ok(results)
}

fn value_as_string(v: &OwnedValue) -> Option<String> {
    if let Value::Str(s) = &**v {
        Some(s.as_str().to_string())
    } else {
        None
    }
}

fn first_node_id(streams: Option<&OwnedValue>) -> Result<u32> {
    let value = streams.ok_or_else(|| anyhow!("portal returned no streams"))?;
    if let Value::Array(arr) = &**value {
        if let Some(Value::Structure(s)) = arr.iter().next() {
            if let Some(Value::U32(id)) = s.fields().first() {
                return Ok(*id);
            }
        }
    }
    Err(anyhow!("could not parse PipeWire node id from streams"))
}

fn next_token(counter: &mut u32) -> String {
    *counter += 1;
    format!("hpm{counter}")
}

fn emit(out: &SharedOut, value: serde_json::Value) {
    if let Ok(mut handle) = out.lock() {
        let _ = writeln!(*handle, "{value}");
        let _ = handle.flush();
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
