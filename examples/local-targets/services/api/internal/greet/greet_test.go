package greet

import "testing"

func TestHello(t *testing.T) {
	if got := Hello("gopher"); got != "Hello, gopher!" {
		t.Fatalf("Hello(%q) = %q, want %q", "gopher", got, "Hello, gopher!")
	}
}
