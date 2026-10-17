//! Prices, kept in whole cents.

/// The total of `prices`, in cents.
///
/// ```
/// assert_eq!(shop_core::total(&[150, 250]), 400);
/// ```
pub fn total(prices: &[u32]) -> u32 {
    prices.iter().sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totals() {
        assert_eq!(total(&[1, 2, 3]), 6);
    }
}
