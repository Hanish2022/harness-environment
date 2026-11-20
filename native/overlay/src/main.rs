mod animation;
mod renderer;
mod sprite;

use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;

use winit::dpi::{LogicalPosition, LogicalSize};
use winit::event::{ElementState, Event, MouseButton, WindowEvent};
use winit::event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy};
use winit::window::{WindowBuilder, WindowLevel};

use animation::{Animator, AvatarState};
use renderer::Renderer;

const SPRITESHEET_BYTES: &[u8] = include_bytes!("../assets/pet_spritesheet.webp");
const WINDOW_SCALE: f64 = 2.0;
const SCREEN_MARGIN: f64 = 40.0;

#[derive(Debug, Clone)]
enum CtlEvent {
    Hide,
    Show,
    Quit,
    SetState(AvatarState),
    SetAmplitude(f32),
}

fn config_dir() -> PathBuf {
    let base = env::var("DOGGIE_HOME").unwrap_or_else(|_| {
        let home = env::var("HOME").unwrap_or_else(|_| ".".into());
        format!("{home}/.doggie")
    });
    PathBuf::from(base)
}

fn position_path() -> PathBuf {
    config_dir().join("position.json")
}

fn load_position(default_x: f64, default_y: f64) -> (f64, f64) {
    if let Ok(text) = fs::read_to_string(position_path()) {
        let x = text
            .split("\"x\":")
            .nth(1)
            .and_then(|s| s.split(|c: char| c == ',' || c == '}').next())
            .and_then(|s| s.trim().parse::<f64>().ok());
        let y = text
            .split("\"y\":")
            .nth(1)
            .and_then(|s| s.split(|c: char| c == ',' || c == '}').next())
            .and_then(|s| s.trim().parse::<f64>().ok());
        if let (Some(x), Some(y)) = (x, y) {
            return (x, y);
        }
    }
    (default_x, default_y)
}

fn save_position(x: f64, y: f64) {
    let _ = fs::create_dir_all(config_dir());
    let _ = fs::write(position_path(), format!("{{\"x\":{:.0},\"y\":{:.0}}}", x, y));
}

fn spawn_stdin_reader(proxy: EventLoopProxy<CtlEvent>) {
    thread::spawn(move || {
        let stdin = std::io::stdin();
        let reader = BufReader::new(stdin.lock());
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            let cmd = if let Some(rest) = line.strip_prefix("state:") {
                AvatarState::parse(rest).map(CtlEvent::SetState)
            } else if let Some(rest) = line.strip_prefix("amp:") {
                rest.trim().parse::<f32>().ok().map(|v| CtlEvent::SetAmplitude(v.clamp(0.0, 1.0)))
            } else {
                match line {
                    "hide" => Some(CtlEvent::Hide),
                    "show" => Some(CtlEvent::Show),
                    "quit" => Some(CtlEvent::Quit),
                    _ => None,
                }
            };
            if let Some(cmd) = cmd {
                if proxy.send_event(cmd).is_err() {
                    break;
                }
            }
        }
    });
}

fn arg_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(|s| s.as_str())
}

/// UV sub-rect (u0,v0,u1,v1) of the spritesheet for the given state at the
/// given point in its row's frame cycle.
fn uv_rect_for(state: AvatarState, frame: u32) -> (f32, f32, f32, f32) {
    let row = sprite::row_for_state(state);
    let sheet_w = (sprite::SHEET_COLS * sprite::CELL_W) as f32;
    let sheet_h = (sprite::SHEET_ROWS * sprite::CELL_H) as f32;
    let u0 = (frame * sprite::CELL_W) as f32 / sheet_w;
    let u1 = ((frame + 1) * sprite::CELL_W) as f32 / sheet_w;
    let v0 = (row * sprite::CELL_H) as f32 / sheet_h;
    let v1 = ((row + 1) * sprite::CELL_H) as f32 / sheet_h;
    (u0, v0, u1, v1)
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let default_width = sprite::CELL_W as f64 * WINDOW_SCALE;
    let default_height = sprite::CELL_H as f64 * WINDOW_SCALE;
    let width: f64 = arg_value(&args, "--width").and_then(|v| v.parse().ok()).unwrap_or(default_width);
    let height: f64 = arg_value(&args, "--height").and_then(|v| v.parse().ok()).unwrap_or(default_height);

    if env::var("WAYLAND_DISPLAY").is_ok() && env::var("DOGGIE_FORCE_WAYLAND").is_err() {
        env::remove_var("WAYLAND_DISPLAY");
    }

    let event_loop: EventLoop<CtlEvent> = EventLoopBuilder::with_user_event().build().unwrap();
    let proxy = event_loop.create_proxy();
    spawn_stdin_reader(proxy);

    // Default spot: bottom-right of the primary monitor, with a margin, so
    // the pet doesn't cover the corner of the screen exactly.
    let (default_x, default_y) = match event_loop.primary_monitor() {
        Some(monitor) => {
            let size = monitor.size();
            let scale = monitor.scale_factor();
            let screen_w = size.width as f64 / scale;
            let screen_h = size.height as f64 / scale;
            (screen_w - width - SCREEN_MARGIN, screen_h - height - SCREEN_MARGIN)
        }
        None => (100.0, 100.0),
    };
    let (x, y) = load_position(default_x, default_y);

    let window = Arc::new(
        WindowBuilder::new()
            .with_title("doggie")
            .with_inner_size(LogicalSize::new(width, height))
            .with_position(LogicalPosition::new(x, y))
            .with_decorations(false)
            .with_transparent(true)
            .with_resizable(false)
            .with_window_level(WindowLevel::AlwaysOnTop)
            .build(&event_loop)
            .unwrap(),
    );

    let sheet = image::load_from_memory(SPRITESHEET_BYTES)
        .expect("failed to decode bundled pet spritesheet")
        .to_rgba8();
    let (sheet_w, sheet_h) = sheet.dimensions();

    let mut renderer = Renderer::new(window.clone(), width as u32, height as u32, sheet.as_raw(), sheet_w, sheet_h);

    let mut animator = Animator::new();

    println!("DOGGIE_OVERLAY_READY");

    let mut dragging = false;
    let mut last_pos = (x, y);
    let frame_interval = std::time::Duration::from_millis(33); // ~30fps, deliberately capped: see ARCHITECTURE.md "idle CPU"
    let mut next_frame = std::time::Instant::now();

    event_loop
        .run(move |event, elwt| {
            match event {
                Event::WindowEvent { event, .. } => match event {
                    WindowEvent::CloseRequested => elwt.exit(),
                    WindowEvent::Resized(size) => renderer.resize(size.width, size.height),
                    WindowEvent::MouseInput {
                        state: ElementState::Pressed,
                        button: MouseButton::Left,
                        ..
                    } => {
                        dragging = true;
                        let _ = window.drag_window();
                    }
                    WindowEvent::MouseInput {
                        state: ElementState::Released,
                        button: MouseButton::Left,
                        ..
                    } => {
                        if dragging {
                            dragging = false;
                            save_position(last_pos.0, last_pos.1);
                        }
                    }
                    WindowEvent::Moved(pos) => {
                        last_pos = (pos.x as f64, pos.y as f64);
                    }
                    WindowEvent::RedrawRequested => {
                        let frame = animator.frame(sprite::FRAMES_PER_ROW);
                        let uv_rect = uv_rect_for(animator.state(), frame);
                        renderer.render(uv_rect);
                    }
                    _ => {}
                },
                Event::UserEvent(cmd) => match cmd {
                    CtlEvent::Hide => window.set_visible(false),
                    CtlEvent::Show => window.set_visible(true),
                    CtlEvent::SetState(s) => animator.set_state(s),
                    CtlEvent::SetAmplitude(_) => {}
                    CtlEvent::Quit => {
                        save_position(last_pos.0, last_pos.1);
                        elwt.exit();
                    }
                },
                Event::AboutToWait => {
                    let now = std::time::Instant::now();
                    if now >= next_frame {
                        window.request_redraw();
                        next_frame = now + frame_interval;
                    }
                    elwt.set_control_flow(ControlFlow::WaitUntil(next_frame));
                }
                Event::LoopExiting => {
                    println!("DOGGIE_OVERLAY_EXIT");
                }
                _ => {}
            }
        })
        .unwrap();
}
