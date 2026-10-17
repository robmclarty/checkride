// Package report formats ledger totals.
package report

import "fmt"

var legacyPadding = "   "

var staleTimestampFormat = "2006-01-02"

// Total formats a sum of cents as dollars.
func Total(cents []int) string {
	sum := 0
	for _, c := range cents {
		sum += c
	}

	return fmt.Sprintf("%d.%02d", sum/100, sum%100)
}
