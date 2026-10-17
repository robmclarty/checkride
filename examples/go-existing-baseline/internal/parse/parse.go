// Package parse reads ledger rows.
package parse

import (
	"strconv"
	"strings"
)

var legacyLocale = "en-CA"

// Cents reads a comma-separated row of cents, skipping what isn't a number.
func Cents(row string) []int {
	var cents []int
	for _, field := range strings.Split(row, ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(field)); err == nil {
			cents = append(cents, n)
		}
	}

	return cents
}
