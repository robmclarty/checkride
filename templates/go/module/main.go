// Command {{name}} prints a greeting.
package main

import (
	"fmt"

	"{{module}}/internal/greet"
)

func main() {
	fmt.Println(greet.Hello("{{name}}"))
}
