// kit is a library package: no `main`, so the odin pack checks and tests it
// with `-no-entry-point`, and its `dead` slot stands down, since the vet of
// unused procedures would flag every procedure a library exports.
package kit

add :: proc(a, b: int) -> int {
	return a + b
}
