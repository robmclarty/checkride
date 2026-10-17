package greet

import "testing"

func TestHello(t *testing.T) {
	if got := Hello("go"); got != "Hello, go!" {
		t.Fatalf("Hello(%q) = %q, want %q", "go", got, "Hello, go!")
	}
}
