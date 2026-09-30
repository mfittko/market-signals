package main

import (
	"reflect"
	"testing"
)

func TestParseOriginsAcceptsHostPortAndOriginForms(t *testing.T) {
	got := parseOrigins(" localhost:3000, http://console.lan:3000 ,https://ops.example/, box:3000/path,,")
	want := []string{"localhost:3000", "console.lan:3000", "ops.example", "box:3000"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseOrigins = %q, want %q", got, want)
	}
}
