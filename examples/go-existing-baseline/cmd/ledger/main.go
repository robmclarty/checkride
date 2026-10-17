// Command ledger prints the total of a row of cents.
package main

import (
	"fmt"

	"example.com/ledger/internal/parse"
	"example.com/ledger/internal/report"
)

func main() {
	fmt.Println(report.Total(parse.Cents("1250,300,75")))
}
