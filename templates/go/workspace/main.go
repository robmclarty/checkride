// Command {{name}} prints a greeting.
package main

import (
	"fmt"

	"{{module}}/core/greet"
)

func main() {
	fmt.Println(greet.Hello("{{name}}"))
}
