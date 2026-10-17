// Command api prints a greeting from the shared greet module.
package main

import (
	"fmt"

	"example.com/shop/greet"
)

func main() {
	fmt.Println(greet.Hello("gopher"))
}
