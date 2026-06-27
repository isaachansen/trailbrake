//! Pure placement math: map a widget's 2-D position on the overlay to a 3-D
//! pose for its VR panel. No platform deps, so it compiles everywhere and is
//! unit-tested in the default build.
//!
//! Convention (OpenVR seated/standing space): right-handed, +X right, +Y up,
//! −Z forward (away from the viewer). The viewer sits near the origin looking
//! down −Z. A widget at the centre of the screen maps to a panel straight ahead
//! at the configured distance; a widget in the top-left maps up and to the left.
//!
//! The returned matrix is a row-major 3×4 `[R | t]` (OpenVR's `HmdMatrix34_t`
//! layout): the first three columns are the panel's orientation basis and the
//! last column is its translation in metres.

/// Horizontal angular span the full overlay width is mapped across (radians).
/// ~70° — wide enough to spread panels around the cockpit without them whipping
/// to the edges of vision.
const H_SPAN: f32 = 70.0 * std::f32::consts::PI / 180.0;
/// Vertical angular span the full overlay height is mapped across (radians).
const V_SPAN: f32 = 44.0 * std::f32::consts::PI / 180.0;

/// Result of placing a panel: the transform plus the panel's physical width.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PanelPose {
    /// Row-major 3×4 transform (OpenVR `HmdMatrix34_t` layout).
    pub matrix: [[f32; 4]; 3],
    /// Panel width in metres (height follows from the texture aspect ratio).
    pub width_m: f32,
}

/// Compute a panel pose from a widget's normalised screen centre.
///
/// - `cx`, `cy`: widget centre in `[0,1]` over the overlay window (cy=0 is top).
/// - `frac_w`: widget width as a fraction of the overlay window width, used so
///   bigger 2-D widgets become bigger VR panels.
/// - `distance_m`: distance to this panel (global distance + per-widget depth).
/// - `scale`: global size multiplier.
///
/// Orientation faces the panel back toward the viewer at the origin. `FACE_SIGN`
/// flips which way the quad's front points; if panels appear mirrored/back-facing
/// on hardware, flip it — it's the one convention OpenVR's docs are vague on.
pub fn panel_transform(cx: f32, cy: f32, frac_w: f32, distance_m: f32, scale: f32) -> PanelPose {
    // Reference: a panel spanning the full overlay width at 1× would be this many
    // metres across at the ring distance. Keeps VR size proportional to 2-D size.
    const FULL_WIDTH_M: f32 = 2.2;

    let d = distance_m.max(0.2);
    let yaw = (cx - 0.5) * H_SPAN; // +yaw = to the right
    let pitch = (0.5 - cy) * V_SPAN; // +pitch = up

    let (sy, cyaw) = yaw.sin_cos();
    let (sp, cp) = pitch.sin_cos();

    // Position on a sphere of radius d around the viewer.
    let pos = [d * sy * cp, d * sp, -d * cyaw * cp];

    // Face the viewer: the quad's +Z (front normal) should point toward the
    // origin, i.e. along -pos. Build a look-at basis from that.
    const FACE_SIGN: f32 = 1.0;
    let fwd = normalize([
        FACE_SIGN * -pos[0],
        FACE_SIGN * -pos[1],
        FACE_SIGN * -pos[2],
    ]);
    let world_up = [0.0, 1.0, 0.0];
    let right = normalize(cross(world_up, fwd));
    let up = cross(fwd, right);

    // Columns: right (X), up (Y), forward (Z), translation.
    let matrix = [
        [right[0], up[0], fwd[0], pos[0]],
        [right[1], up[1], fwd[1], pos[1]],
        [right[2], up[2], fwd[2], pos[2]],
    ];

    let width_m = FULL_WIDTH_M * frac_w.clamp(0.0, 1.0) * scale.max(0.05);
    PanelPose { matrix, width_m }
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn normalize(v: [f32; 3]) -> [f32; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len <= f32::EPSILON {
        [0.0, 0.0, 1.0]
    } else {
        [v[0] / len, v[1] / len, v[2] / len]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn centre_widget_is_straight_ahead() {
        let p = panel_transform(0.5, 0.5, 1.0, 0.9, 1.0);
        // Dead ahead: on -Z at the distance, no lateral/vertical offset.
        assert!(approx(p.matrix[0][3], 0.0), "x={}", p.matrix[0][3]);
        assert!(approx(p.matrix[1][3], 0.0), "y={}", p.matrix[1][3]);
        assert!(approx(p.matrix[2][3], -0.9), "z={}", p.matrix[2][3]);
        // Facing the viewer: front normal points back toward +Z (origin side).
        assert!(p.matrix[2][2] > 0.9, "fwd_z={}", p.matrix[2][2]);
    }

    #[test]
    fn right_widget_goes_right_and_back() {
        let p = panel_transform(1.0, 0.5, 1.0, 1.0, 1.0);
        assert!(p.matrix[0][3] > 0.0, "expected +x, got {}", p.matrix[0][3]);
        assert!(p.matrix[2][3] < 0.0, "expected -z, got {}", p.matrix[2][3]);
    }

    #[test]
    fn top_widget_goes_up() {
        let p = panel_transform(0.5, 0.0, 1.0, 1.0, 1.0);
        assert!(p.matrix[1][3] > 0.0, "expected +y, got {}", p.matrix[1][3]);
    }

    #[test]
    fn distance_clamped_and_width_scales() {
        let near = panel_transform(0.5, 0.5, 0.5, 1.0, 1.0);
        let wide = panel_transform(0.5, 0.5, 1.0, 1.0, 1.0);
        assert!(wide.width_m > near.width_m);
        // Scale multiplies width.
        let big = panel_transform(0.5, 0.5, 1.0, 1.0, 2.0);
        assert!(big.width_m > wide.width_m);
    }

    #[test]
    fn orientation_columns_are_unit_and_orthogonal() {
        let p = panel_transform(0.8, 0.2, 0.4, 1.2, 1.0);
        // Extract basis columns.
        let col = |c: usize| [p.matrix[0][c], p.matrix[1][c], p.matrix[2][c]];
        for c in 0..3 {
            let v = col(c);
            let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            assert!(approx(len, 1.0), "col {c} not unit: {len}");
        }
        let dot = |a: [f32; 3], b: [f32; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        assert!(approx(dot(col(0), col(1)), 0.0));
        assert!(approx(dot(col(1), col(2)), 0.0));
        assert!(approx(dot(col(0), col(2)), 0.0));
    }
}
