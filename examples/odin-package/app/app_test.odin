// `#+test` keeps this file out of `odin check`, so the unused-procedure vet
// never sees `twice_doubles`, which nothing calls; `odin test` compiles it.
#+test
package app

import "core:testing"

@(test)
twice_doubles :: proc(t: ^testing.T) {
	testing.expect(t, twice(2) == 4)
}
