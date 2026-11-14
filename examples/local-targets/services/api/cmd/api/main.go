// Command api prints a greeting.
package main

import (
	"fmt"

	"example.com/shop/api/internal/greet"
)

func main() {
	fmt.Println(greet.Hello("gopher"))
}
