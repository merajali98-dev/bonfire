/// 128x128 -> 256-bit multiply, returned as (hi, lo).
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    const MASK: u128 = u64::MAX as u128;
    let (a0, a1) = (a & MASK, a >> 64);
    let (b0, b1) = (b & MASK, b >> 64);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & MASK) + (p10 & MASK);
    let lo = (p00 & MASK) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// floor(a * b / d) without intermediate overflow. Panics if d == 0 or the quotient exceeds u128.
pub fn mul_div(a: u128, b: u128, d: u128) -> u128 {
    assert!(d > 0, "division by zero");
    let (hi, lo) = mul_wide(a, b);
    assert!(hi < d, "mul_div overflow");
    let mut rem = hi;
    let mut q: u128 = 0;
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            q |= 1;
        }
    }
    q
}

/// Creator payout under the matching curve: budget * min(counted, target) / target.
pub fn matched_payout(budget: u128, counted: u128, target: u128) -> u128 {
    mul_div(budget, counted.min(target), target)
}

/// Candle checkpoint index for a timestamp inside [candle_start, backing_close).
pub fn checkpoint_index(now: u64, candle_start: u64, backing_close: u64, checkpoints: u8) -> u8 {
    let span = (backing_close - candle_start) as u128;
    let elapsed = (now - candle_start) as u128;
    let k = elapsed * checkpoints as u128 / span;
    k.min(checkpoints as u128 - 1) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_div_matches_small_values() {
        for a in [0u128, 1, 7, 1000, u64::MAX as u128] {
            for b in [0u128, 1, 3, 999] {
                for d in [1u128, 2, 1000, 12345] {
                    if b <= d {
                        assert_eq!(mul_div(a, b, d), a * b / d);
                    }
                }
            }
        }
    }

    #[test]
    fn mul_div_handles_large_values() {
        let near = 10u128.pow(24);
        let ember = 10u128.pow(18);
        let budget = 20 * near;
        let target = 40_000 * ember;
        assert_eq!(matched_payout(budget, 10_000 * ember, target), 5 * near);
        assert_eq!(matched_payout(budget, 40_000 * ember, target), budget);
        assert_eq!(matched_payout(budget, 90_000 * ember, target), budget);
        assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
        assert_eq!(mul_div(u128::MAX, 3, 7), (u128::MAX / 7) * 3 + (u128::MAX % 7) * 3 / 7);
    }

    #[test]
    fn checkpoints_cover_window() {
        assert_eq!(checkpoint_index(100, 100, 220, 12), 0);
        assert_eq!(checkpoint_index(109, 100, 220, 12), 0);
        assert_eq!(checkpoint_index(110, 100, 220, 12), 1);
        assert_eq!(checkpoint_index(219, 100, 220, 12), 11);
        assert_eq!(checkpoint_index(150, 100, 220, 1), 0);
    }
}
