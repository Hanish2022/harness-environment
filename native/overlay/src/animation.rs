use std::time::Instant;

/// Mirrors the state table in the top-level spec section 12. Driven over the
/// same stdin control channel as hide/show/quit (`state:<NAME>`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AvatarState {
    Idle,
    Listening,
    Transcribing,
    Thinking,
    Speaking,
    Executing,
    Waiting,
    Completed,
    Error,
    Interrupted,
}

impl AvatarState {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "IDLE" => Self::Idle,
            "LISTENING" => Self::Listening,
            "TRANSCRIBING" => Self::Transcribing,
            "THINKING" => Self::Thinking,
            "SPEAKING" => Self::Speaking,
            "EXECUTING" => Self::Executing,
            "WAITING_FOR_APPROVAL" | "WAITING_FOR_INPUT" | "WAITING" => Self::Waiting,
            "COMPLETED" => Self::Completed,
            "ERROR" => Self::Error,
            "INTERRUPTED" => Self::Interrupted,
            _ => return None,
        })
    }
}

const FRAME_FPS: f32 = 6.0;

/// Tracks the current state and ticks through the sprite sheet's per-row
/// frames over time. Replaces the earlier Mat4-based 3D pose animator, which
/// has no equivalent in a 2D sprite-cell model — there's no skeleton to pose,
/// just "which frame of this row to show right now."
pub struct Animator {
    start: Instant,
    state: AvatarState,
}

impl Animator {
    pub fn new() -> Self {
        Self { start: Instant::now(), state: AvatarState::Idle }
    }

    pub fn set_state(&mut self, state: AvatarState) {
        self.state = state;
    }

    pub fn state(&self) -> AvatarState {
        self.state
    }

    /// Which column (0..frames_per_row) to sample right now.
    pub fn frame(&self, frames_per_row: u32) -> u32 {
        let t = self.start.elapsed().as_secs_f32();
        (t * FRAME_FPS) as u32 % frames_per_row
    }
}
