// Command greeter prints a greeting.
package main

import (
	"fmt"

	"example.com/greeter/internal/greet"
)

func main() {
	fmt.Println(greet.Hello("gopher"))
}
