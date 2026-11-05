// app is a program: it has a `main`, so the unused-procedure vet runs over
// its own package (`-vet-packages:app`) and never over kit's.
package app

import "core:fmt"
import kit "../kit"

main :: proc() {
	fmt.println(twice(2))
}

twice :: proc(n: int) -> int {
	return kit.add(n, n)
}
