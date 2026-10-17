//! Greetings.

/// Greets `name`.
///
/// ```
/// assert_eq!({{crate}}::hello("rust"), "Hello, rust!");
/// ```
pub fn hello(name: &str) -> String {
    format!("Hello, {name}!")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greets() {
        assert_eq!(hello("rust"), "Hello, rust!");
    }
}
