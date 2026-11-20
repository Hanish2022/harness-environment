use crate::animation::AvatarState;

/// Grid layout of the pet spritesheet (confirmed via the source site's own
/// published validation metadata: 1536x1872 atlas, 192x208 cells — this
/// convention is consistent across pets from this source, not specific to
/// one asset, so this loader works for any pet sharing the same format).
pub const SHEET_COLS: u32 = 8;
pub const SHEET_ROWS: u32 = 9;
pub const CELL_W: u32 = 192;
pub const CELL_H: u32 = 208;

/// Not every row has all 8 columns populated (some end early with empty/
/// transparent cells). Rather than inspect alpha per-cell, use the smallest
/// frame count observed across all rows (4) for every row — sacrifices a
/// little animation variety in the fuller rows, but guarantees never
/// sampling an empty cell regardless of which row a state maps to.
pub const FRAMES_PER_ROW: u32 = 4;

/// Best-effort mapping from Doggie's state table (spec section 12) onto
/// this specific pet's rows, chosen by looking at what each row actually
/// depicts — there's no official per-row semantic label from the source,
/// so this is a judgment call, not a documented contract. A different pet
/// asset (different art) would need its own mapping.
pub fn row_for_state(state: AvatarState) -> u32 {
    match state {
        AvatarState::Idle => 8,           // sitting calmly at a laptop
        AvatarState::Listening => 1,      // standing, phone in hand, attentive
        AvatarState::Transcribing => 1,
        AvatarState::Thinking => 2,       // standing, phone, alternate angle
        AvatarState::Speaking => 8,       // no distinct "talking" frame in this sheet; reuse idle
        AvatarState::Executing => 0,      // actively typing at a desktop
        AvatarState::Waiting => 6,        // lying down, phone, waiting
        AvatarState::Completed => 3,      // two cats together, content
        AvatarState::Error => 5,          // crying / visibly stressed
        AvatarState::Interrupted => 4,    // startled "ghost" pose
    }
}
